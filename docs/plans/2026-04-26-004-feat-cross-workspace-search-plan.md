---
title: Cross-workspace search via Python sidecar
type: feat
status: active
date: 2026-04-26
origin: docs/brainstorms/2026-04-26-search-requirements.md
---

# Cross-workspace search via Python sidecar

## Overview

Adds workspace-wide search (Cmd+K palette + dedicated view) backed by a long-running Python sidecar that owns hybrid keyword + vector + cross-encoder rerank retrieval over notes, mounted text/PDF/image content, and the URL cache. Rust remains the source of truth for `cognios.db` and forwards node-mutation events to the sidecar over loopback HTTP. The plan delivers in five phases — sidecar foundations → indexing → retrieval → UI → hardening — so a working FTS-only search ships well before the full ML stack lands.

## Problem Frame

Cognios currently has no search. Past tree-navigable size (a few hundred nodes), users cannot find specific notes, locate a forgotten URL, or pull together everything related to a topic. The brainstorm (origin doc) settled the product direction: pure search (no Q&A in v1), agent-callable, hybrid retrieval that degrades gracefully to FTS-only when ML models are unavailable, with a Python sidecar owning the index because Python's ML ecosystem is materially better suited than Rust's. This plan makes the foundational architectural decisions concrete and sequences the implementation so the team can ship value incrementally.

## Requirements Trace

P0 requirements that must be satisfied to call v1 done (see origin: docs/brainstorms/2026-04-26-search-requirements.md):

- **R1** `search(query, filters?)` IPC returns ranked nodes — Units 7, 8.
- **R2** result row schema (node_id, kind, name, score, snippet, matched_in, path) — Units 6, 7.
- **R3** per-node aggregation; agents call existing per-kind read commands — Units 6, 7.
- **R4** hybrid retrieval with FTS-only fallback — Units 6, 11.
- **R5 (kind/mount filters)** inline operators in Cmd+K — Units 7, 8.
- **R6** invalid syntax falls through silently — Unit 7.
- **R7** indexed sources: notes, mounted .md/.txt, URL cache, PDF, image (OCR + caption) — Unit 5.
- **R8** name + metadata indexed for keyword path — Unit 5.
- **R10** background queue, non-blocking saves/mounts — Units 1, 5.
- **R12** node deletion / mount removal cleans index — Unit 5.
- **R13** per-content-type pipelines — Unit 5.
- **R13+** per-job timeouts and memory caps — Unit 5.
- **R14** Cmd+K palette — Unit 8.
- **R16** both surfaces share the same API — Unit 7.
- **R22** `~/.cogios/search/` storage layout — Units 2, 6.
- **R23** crash safety; sidecar resumes from disk; HTTP retry on Rust side — Units 1, 2, 5.

P1 requirements (must ship by user intent):

- **R5+ (date filters)** inline + dedicated-view UI — Units 7, 9.
- **R9** per-mount kind tag — Unit 5.
- **R11** indexing status surfaced via sidecar HTTP query (no Rust schema change) — Units 5, 7, 8.
- **R15** dedicated search view — Unit 9.
- **R17/R18** provider abstraction per ML role + privacy disclosure — Units 4, 10.
- **R19/R20/R21** ModelManager + first-run + cold-start UX — Units 4, 11.
- **Default models** loaded and runnable — Units 4, 6.

## Scope Boundaries

- **No Q&A / RAG synthesis.** Agent integration is search-only via the existing `get_note_content` / `read_file_content` IPC commands. (Origin: out of scope.)
- **No high-end PDF parsing.** PyMuPDF + per-page OCR fallback is the contract; no `marker`, `surya`, or layout-aware extraction.
- **No code-aware indexing.** Mount kind `code` remains a future extension hook; v1 ships `general` only.
- **No search history, smart folders, autocomplete, or click-feedback learning.**
- **macOS arm64 is the only supported v1 target.** macOS x86_64, Linux, and Windows are explicitly deferred — see Risks.
- **No new modifier-key behaviours** (Cmd+Enter / Shift+Enter) in Cmd+K v1.
- **Touch / mobile** is out of scope.
- **The brainstorm's mention of `tauri-plugin-shell` being "already added" is partially false.** The plugin is registered for `shell:allow-open` (URL opening) only. The plan treats sidecar wiring as new work, not retrofit.

## Context & Research

### Relevant Code and Patterns

**Background-queue precedent** (existing url-indexing pipeline)
- `src-tauri/src/services/url_indexing/queue.rs` — `UrlJobRunner` with `Arc<Mutex<HashSet<String>>>` for in-flight dedup, `std::thread::spawn` per job (no shared worker pool), fire-and-forget `enqueue(node_id)`.
- `src-tauri/src/services/url_indexing/registry.rs` — single-line dispatcher; the search-side equivalent for per-content-type pipelines lives in Python, not here.
- `src-tauri/src/infrastructure/db/url_repository.rs` — state-transition helpers (`mark_url_indexing/indexed/error`, `requeue_stale_jobs`, `list_pending_job_ids`).
- Crash-resume pattern is `resume_pending_jobs()` called once on app start (`src-tauri/src/lib.rs:73`).

**VFS event emission** (canonical sink)
- `src-tauri/src/lib.rs` defines `VFS_EVENT_NAME = "vfs://changed"` and the single `app_handle.emit(...)` call.
- Payload type `VfsChangeEvent { mount_id, reason }` declared in `src-tauri/src/services/mounts/watcher.rs:17-22` (note the misnamed `mount_id` field — also carries url-job node ids).
- TS mirror: `src/lib/tauri/events.ts`. Subscriber: `src/features/explorer/hooks/useExplorerEvents.ts`.
- **Gap:** notes mutations (`create_note`, `save_note_content`, `delete_node`, `rename_node`) and `create_folder` do **not** fire events today. The frontend re-renders from the snapshot returned by each IPC call. The sidecar cannot subscribe to mutations until these emit.

**IPC command pattern**
- One file per feature in `src-tauri/src/commands/`. Each `#[tauri::command]` takes `state: State<'_, AppState>` + an input struct with `#[serde(rename_all = "camelCase")]`.
- TS-side typed wrapper in `src/lib/tauri/ipc.ts`; feature-scoped client in `src/features/<feature>/api/<feature>Client.ts`.
- Commands registered via `invoke_handler![...]` in `src-tauri/src/lib.rs:84-99`.

**Modal / overlay precedent**
- `src/features/explorer/components/MountModal.tsx` is the canonical modal: `<div className="modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>` wrapping a `<div className="modal">` with `modal-header`/`modal-body`/`modal-footer`. Escape-to-close via local `useEffect`.
- `src/app/AppSidebar.tsx:67-92` already contains a Cmd+K stub (`searchOpen` state + `<div className="search-overlay" role="dialog">` + Escape handler) — Unit 8 replaces this stub with the real palette.

**Test conventions**
- TS: Vitest + `@testing-library/react`. Tauri APIs mocked at module level (`vi.mock("@tauri-apps/api/event", ...)`). Client mocking via a `makeClient()` factory returning an interface populated with `vi.fn()` per method. Naming: `describe("ComponentName", () => { it("does something specific", ...) })` with `afterEach(cleanup)`.
- Rust: integration tests in `src-tauri/tests/*.rs` using `cognios_lib::...`. `tempfile::tempdir()` for temp scaffolds. Background jobs polled with a deadline loop (see `src-tauri/tests/url_indexing.rs:69-120`).
- Python sidecar tests will use `pytest` + `httpx.AsyncClient` against the FastAPI app. New convention.

**Cmd+K stub already present**
- `src/app/AppSidebar.tsx:67-92` shows "Search is not yet implemented in this milestone." — Unit 8 replaces this.

### Institutional Learnings

- No `docs/solutions/` corpus yet.
- **Within-session learnings from the notes feature** (recently shipped): debounce timers must be cleared on unmount; `nodeId` should be captured via a ref to avoid stale-closure writes; flush errors must surface, not be silently swallowed by `.catch(() => {})`. The search sidecar's HTTP client on the Rust side has analogous failure modes — apply the same care.

### External References

Authoritative findings from research (full citations in research dispatch outputs):

- **Tauri sidecar wiring** ([v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/)) — `bundle.externalBin` takes the path *without* the platform suffix; sibling files are required at `binaries/<name>-<host-tuple>`. Capability scope must include both `shell:allow-execute` and `shell:allow-spawn` for a long-running server. `args` accepts literal strings or `{"validator": "<regex>"}` entries.
- **`tauri-plugin-shell` Rust API** — `app.shell().sidecar("name").args([...]).spawn()` returns `(rx, child)`; `child.kill()` and `rx.recv()` for `CommandEvent::{Stdout, Stderr, Terminated}`. No built-in supervisor — restart loop is our work.
- **`bundle.active = false`** only suppresses release packaging; dev-mode sidecar resolution is unaffected.
- **lancedb** ([lancedb.github.io/lancedb](https://lancedb.github.io/lancedb/python/python/)) — has stable native hybrid search (`tbl.search(text, query_type="hybrid")`) with `RRFReranker` default, FTS via lance-index (no Tantivy build dep with `use_tantivy=False`). Latest release is 0.30.x; macOS x86_64 wheels dropped at 0.26 — Apple Silicon only.
- **Gemma 3n E2B** ([huggingface.co/google/gemma-3n-E2B-it](https://huggingface.co/google/gemma-3n-E2B-it)) — multimodal (image + text → text), 4.46 B raw params, ~2 B effective via MatFormer. `unsloth/gemma-3n-E2B-it-GGUF` Q4_K_M is ~3 GB. **Serving via the `llama-server` C++ binary out-of-process** (the official llama.cpp HTTP server distributed at [github.com/ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases)). Prebuilt binaries available for macOS arm64, macOS x86_64, Windows, Linux x86_64, and Linux arm64 — eliminates the cmake + xcode-select source-build dependency that the Python `llama-cpp-python` binding would otherwise require. Spike v1 (sidecar/spike/README.md F-1) confirmed `llama-cpp-python` is sdist-only on PyPI; the out-of-process binary is the strict win. Multimodal vision is enabled via the `--mmproj <vision-encoder.gguf>` flag (Gemma 3n ships a separate vision projection head). Gated download (Gemma license acceptance) — bundle license-acceptance flow into ModelManager UI, do **not** redistribute weights in the installer.
- **gte multilingual ONNX** — `onnx-community/gte-multilingual-base` and `onnx-community/gte-multilingual-reranker-base` ship pre-quantized ONNX. Reranker int8 = 341 MB. `optimum.onnxruntime.ORTModelForSequenceClassification.from_pretrained(..., file_name="model_int8.onnx")` is the call path. Neither is in fastembed's curated registry — do not rely on fastembed.
- **PaddleOCR ONNX-only** ([github.com/PaddlePaddle/PaddleOCR/discussions/14572](https://github.com/PaddlePaddle/PaddleOCR/discussions/14572)) — use `paddleocr-onnx` or `paddlex[ocr-core]>=3.4` + `onnxruntime`. Drop `paddlepaddle` entirely. PP-OCRv4 mobile det+rec+cls ONNX combined ~15-20 MB.
- **PyInstaller** ([pyinstaller.org/en/stable](https://pyinstaller.org/en/stable/usage.html)) — `--onedir` only (not `--onefile`) for ML stacks. Use CPU-only PyTorch wheels if torch is needed (we likely won't ship torch since the sidecar uses ONNX + GGUF).

## Key Technical Decisions

**Architecture**

- **lancedb owns both FTS and vector storage.** Originally the brainstorm split FTS5 (SQLite) from vectors (lancedb); research confirms lancedb has stable native hybrid retrieval. Single storage technology, single hybrid API call (`query_type="hybrid"`), simpler crash recovery. The brainstorm's mention of "FTS database (SQLite FTS5 via Python `sqlite3`)" is superseded by this plan; the queue state alone uses SQLite.
- **GGUF + `llama-server` (out-of-process) for Gemma serving.** The official llama.cpp `llama-server` C++ binary is bundled under `src-tauri/binaries/llama-server-<host-tuple>` (sibling of `search-sidecar`). The Python sidecar invokes it via OpenAI-compatible HTTP on a separate loopback port. Replaces the brainstorm's implied transformers + torch path. Net wins: (a) eliminates `cmake` + `xcode-select` source-build dependency and `llama-cpp-python`'s sdist-only PyPI gap (spike v1 finding F-1), (b) cleaner cross-platform story (llama.cpp publishes prebuilt binaries for all v1 targets vs. `llama-cpp-python`'s no-prebuilds-anywhere), (c) strict process isolation — captioning crashes do not bring down the search sidecar, and the captioner can be killed + respawned by the supervisor to bound KV-cache growth. The runtime topology gains one process; the bundle topology stays single-installer.
- **ONNX + `optimum.onnxruntime` for embedding and reranker.** Pulls pre-quantized models from `onnx-community/*`. Avoids `optimum-cli` export step in CI.
- **PaddleOCR ONNX-only** via `paddleocr-onnx` (or `paddlex[ocr-core]` + `onnxruntime`). No `paddlepaddle` dependency.
- **Sidecar packaging via PyInstaller `--onedir`** with the platform-suffixed binary placed at `src-tauri/binaries/search-sidecar-<host-tuple>`. Build is a separate CI step that runs before `tauri build`.
- **Loopback HTTP, bearer-token auth.** Sidecar binds 127.0.0.1 only; generates a 256-bit token at startup; writes `{port, token}` to `~/.cogios/search/sidecar.runtime` (mode 0600, atomic write via `os.replace`); the sidecar holds an `fcntl.flock` on the runtime file for its lifetime so a second instance cannot start. Rust reads the file (rejecting symlinks via `fs::symlink_metadata`) before issuing any request and includes `Authorization: Bearer <token>` on every call; the sidecar middleware uses `hmac.compare_digest` for constant-time comparison. **Threat-model honesty:** this scheme blocks cross-user attacks and network-level SSRF but does **not** block a same-user co-resident process from reading `sidecar.runtime` and impersonating Rust to the sidecar — that gap is accepted because such a process can already read `~/.cogios/notes/` directly. If the threat model changes, the token can move to OS keychain (read at IPC time, never on disk) at the cost of one keychain prompt per cold start.
- **Path-traversal responsibility lives in Rust.** Mirror of the existing canonicalize-and-verify pattern in `src-tauri/src/services/files/read_file_content.rs`. The sidecar accepts only absolute paths supplied via Rust events; `queue.db` rows are write-once at enqueue time.
- **Storage layout under `~/.cogios/search/`:** `index.lance/` (lancedb), `queue.db` (SQLite, sidecar-owned), `models/<role>/<commit-hash>/`, `sidecar.runtime`, `sidecar.log`.
- **Indexing state ownership:** The sidecar owns indexing state. Rust does **not** add an `indexing_state` column to `cognios.db`. The UI queries `GET /index/status` for global queue depth and `GET /index/status/<node_id>` for per-node state. Closes the two-writer problem.
- **No new VFS event types.** The existing `vfs://changed` payload (`{ mount_id, reason }`) is reused, and a parallel HTTP push from Rust to the sidecar carries the resolved absolute content path. The sidecar does not subscribe to Tauri events directly — Rust forwards each mutation as an outgoing HTTP `POST /events/node` call.
- **Stale-result defence in depth.** Search results may name a `node_id` that has been deleted between the search and a subsequent read. The contract is that agents and the UI treat "not found" from `get_*_content` as a normal outcome. **Additionally:** the Rust `searchQuery` command cross-checks the returned `node_id` set against `cognios.db` and drops not-found IDs before returning to the UI (one batched `SELECT id FROM nodes WHERE id IN (?, ...)` — ~1 ms for 15 IDs against the indexed PK). Closes the UI surprise; agents that bypass Rust still need to handle the not-found outcome themselves.
- **Backfill / resync (v1, not v1b).** Rust forwards mutations as fire-and-forget `POST /events/node`. To handle the cases where the sidecar was offline during a mutation (supervisor restart window), being installed onto a workspace with pre-existing nodes, or restarted after a `queue.db` rebuild, Rust runs a periodic resync ping every 60 s: `POST /events/resync` carrying the current `nodes` table id-set as `{ ids: [...] }`. The sidecar diffs against its own `queue.db` + lancedb, enqueues newly-seen nodes as `pending`, and deletes lancedb rows for ids no longer in the set. The same call also runs once at sidecar startup to handle the on-install backfill case.
- **All timestamps are UTC.** IPC payload timestamps are RFC3339 UTC strings; lancedb stores them as UTC. Date-filter relative syntax (`created:7d`) is converted to absolute UTC at the Rust IPC boundary, not in lancedb SQL — avoids cross-process clock-drift and DST surprises.

**Sidecar lifecycle**

- **Startup:** spawned by the Rust supervisor at app launch via `app.shell().sidecar("search-sidecar")`. CLI args: `--storage-dir <path-to-~/.cogios>`. Sidecar writes `sidecar.runtime` once it has bound the port and is accepting requests.
- **Health check:** `GET /healthz` returns `{state: "ready" | "initialising" | "models_missing", models: {<role>: "ready" | ...}}`. Polled by Rust on a 1 s interval during cold-start; Rust treats absence of `sidecar.runtime` after 30 s as a failure.
- **Restart:** on `CommandEvent::Terminated`, Rust applies exponential backoff (1 s → 2 s → 4 s) up to 3 attempts before surfacing "search unavailable" to the UI. The runtime file is rewritten by the new process.
- **Shutdown:** Rust calls `child.kill()` on app close. Single-instance enforcement is via the `fcntl.flock` on `sidecar.runtime` (see above) — replaces the brainstorm's brittle file-deletion sentinel scheme.
- **Lazy model loading.** Sidecar starts uvicorn immediately after binding the socket (sub-second) and serves `GET /healthz` with `state: "initialising"` while ML model loads run on a background thread. Rust never times out on the runtime-file presence check as long as bind succeeded; the 30 s timeout becomes "failed to bind a port", not "models not loaded yet". This decouples cold-start time (which can run 10–30 s on a slow disk) from the supervisor's restart budget.

**API contract** (Rust ↔ sidecar)

```
GET  /healthz
GET  /index/status                  -> { queue_depth, in_flight: [...], degraded: bool }
GET  /index/status/<node_id>        -> { state: pending|indexing|indexed|error, indexed_at?, error? }
POST /events/node                   -> { event: "changed"|"deleted", node_id, kind, name, absolute_content_path?, mount_id?, created_at, updated_at }
POST /search                        -> { query, filters?, limit?, cursor? } -> { results: [...], degraded: bool, partial: { indexed, total }?, state?: "initialising"|"unavailable" }
POST /events/resync                 -> { ids: [<node_id>, ...] } -> { added: int, removed: int }
GET  /models/status                 -> { <role>: { state, progress?, error? } }
POST /models/download               -> { role, model_id, commit_hash, sha256_manifest } -> SSE stream of progress
POST /models/select                 -> { role, provider: { type, ... } }
POST /models/accept-license         -> { role } -> { accepted: true }   (idempotent; persists across restart)
```

All requests require `Authorization: Bearer <token>` (read from `sidecar.runtime`). Response envelopes use `{ ok: true, data }` on success or `{ ok: false, error: { code, message } }` on failure; HTTP status codes mirror the standard semantics.

**UX**

- **Cmd+K result count** is capped at 15. "More results in dedicated view (⇧⌘F)" is the 16th row when more matches exist.
- **Pre-query empty state** in Cmd+K shows the top 10 most-recently-modified nodes (any kind). Avoids the "blank palette" anti-pattern without invoking search-history scope.
- **Models-not-ready** is non-blocking after first run. The palette accepts queries during cold-start and returns FTS-only results plus a "Search initialising…" hint.
- **First-run** is a blocking onboarding modal with per-model progress, Cancel, Retry, and "Skip for now (FTS-only)".
- **Settings** is a new fifth section in `src/app/AppSidebar.tsx` (`home / chat / explorer / memory / settings`). The Settings page contains per-role provider config, ModelManager status, the privacy disclosure (R18+), and license-acceptance for Gemma weights.

**Brainstorm corrections**

- Gemma model ID corrected: brainstorm says `google/gemma-3-e2b-it`; correct is **`google/gemma-3n-E2B-it`**. The plan uses the correct name throughout.
- Reranker is loaded from `onnx-community/gte-multilingual-reranker-base` (`model_int8.onnx`), not from the original `Alibaba-NLP/*` repo (which ships safetensors only).
- PaddleOCR runtime is **`paddleocr-onnx` / `paddlex[ocr-core]` + `onnxruntime`**, not `paddlepaddle`. Bundle size revised down to ~50 MB.
- Total first-run download is **~4.3 GB** (embedding 620 MB ONNX int8 + reranker 341 MB ONNX int8 + OCR 50 MB + Gemma GGUF 3 GB), revised down from the brainstorm's ~6.2 GB estimate. Update `R21` UX copy accordingly.
- Sidecar capability needs **both** `shell:allow-execute` and `shell:allow-spawn` (long-running server).

## Open Questions

### Resolved During Planning

- **Gemma serving stack:** GGUF + `llama-server` C++ binary out-of-process, not `llama-cpp-python` in-process. (Saves ~1 GB bundle vs. the transformers + torch path; saves another ~80 MB + cmake/xcode prereqs vs. the embedded `llama-cpp-python` path; provides strict process isolation; better cross-platform binary distribution story.)
- **FTS storage:** lancedb's native FTS, not SQLite FTS5. (Single storage technology; native hybrid retrieval.)
- **Reranker quantization:** ship `model_int8.onnx` directly from `onnx-community/*`. No `optimum-cli` export.
- **OCR runtime:** ONNX-only path (`paddleocr-onnx`). Drop `paddlepaddle`.
- **Sidecar packaging tool:** PyInstaller `--onedir`. (`PyOxidizer` is unmaintained; `Nuitka` has friction with Rust-extension wheels.)
- **Indexing-state ownership:** sidecar owns it; Rust queries via HTTP. No `cognios.db` schema change.
- **Auth scheme:** 256-bit bearer token in `sidecar.runtime` file (mode 0600), bound to 127.0.0.1.
- **Path-traversal responsibility:** Rust canonicalises; sidecar trusts only Rust-supplied paths.
- **Capability scope:** include both `shell:allow-execute` and `shell:allow-spawn`, scoped to `binaries/search-sidecar` only.
- **VFS emit gaps:** notes/mutations/create_folder paths must emit before sidecar can stay in sync. Unit 1 closes this.

### Deferred to Implementation

- **Exact chunking strategy** (chunk size, overlap, paragraph vs sentence vs sliding window) — measure against real notes/PDFs in Unit 5.
- **lancedb FTS tokenizer for Chinese mixed content** — try the default tokenizer first; switch to `jieba`-preprocessed text if recall is poor.
- **CSP directive text** — once Unit 8/9 are concrete, derive the minimal CSP that allows the new render surfaces. Unit 12.
- **Sidecar restart backoff schedule** — start with 1 s/2 s/4 s; tune if churn is observed.
- **Indexing throughput targets** — measure first; tune queue concurrency.
- **OCR language packs** — PP-OCRv4 mobile defaults are multilingual; Chinese-specific weights need separate verification when Unit 5 runs against real Chinese images.
- **Re-index on embedding model swap** — full vs incremental. Likely full since dimensions change; confirm with the lancedb table-rebuild approach in Unit 6.
- **PyInstaller hidden-imports list and bundle smoke test on macOS arm64** — verify with a real package build at the end of Unit 12. Research surfaced the imports list but real-world friction is implementation-time.
- **Gemma license acceptance UX flow details** — settings page copy + accept-and-download button text, Unit 10.

### Sequencing Question (product-level, surfaced for visibility)

- **When does Q&A / synthesis enter scope?** Out of scope for v1 by explicit decision (origin), but the brainstorm flags this as a "deliberate next-iteration decision, not a drift." Not blocking this plan.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Component interaction (steady-state)

```
┌────────────────────┐                                ┌──────────────────────────┐
│  React UI          │                                │  Python sidecar          │
│  - Cmd+K palette   │                                │  (FastAPI on 127.0.0.1)  │
│  - Search view     │                                │                          │
│  - Settings        │                                │  ┌────────────────────┐  │
└────────┬───────────┘                                │  │ /search            │  │
         │ invoke()                                   │  │ /index/status      │  │
         ▼                                            │  │ /events/node       │  │
┌────────────────────┐  POST /events/node             │  │ /healthz           │  │
│  Rust              │  POST /search          ┌──────►│  │ /models/*          │  │
│  - commands/       │  GET  /index/status    │       │  └─────────┬──────────┘  │
│  - SidecarClient   ├────────────────────────┘       │            │             │
│  - VfsChange emit  │  (Bearer: <token>              │            ▼             │
│  - mutation paths  │   read from sidecar.runtime)   │  ┌────────────────────┐  │
└──┬─────────────────┘                                │  │ Indexer queue      │  │
   │ spawns                                           │  │ - per-content type │  │
   │ via app.shell().sidecar(...)                     │  │ - timeouts/retries │  │
   ▼                                                  │  └─────────┬──────────┘  │
┌────────────────────┐                                │            │             │
│  cognios.db        │                                │            ▼             │
│  (Rust-owned)      │                                │  ┌────────────────────┐  │
│  - nodes           │                                │  │ ModelManager       │  │
│  - mounts          │                                │  │ - download/verify  │  │
│  - url_jobs        │                                │  │ - SSE progress     │  │
└────────────────────┘                                │  └─────────┬──────────┘  │
                                                      │            │             │
                                                      │            ▼             │
                                                      │  ┌────────────────────┐  │
                                                      │  │ ~/.cogios/search/  │  │
                                                      │  │  - index.lance/    │  │
                                                      │  │  - queue.db        │  │
                                                      │  │  - models/         │  │
                                                      │  │  - sidecar.runtime │  │
                                                      │  └────────────────────┘  │
                                                      └──────────────────────────┘
```

### State transitions for an indexing job

```
                     ┌──────────────┐
   POST /events/node │   pending    │  (persisted in queue.db)
   ──────────────────►              │
                     └──────┬───────┘
                            │ runner picks it up
                            ▼
                     ┌──────────────┐
                     │  indexing    │
                     │ (in-flight)  │
                     └──┬────────┬──┘
            success     │        │   timeout / OOM / unhandled exception
                        ▼        ▼
                 ┌───────────┐  ┌──────────┐
                 │  indexed  │  │  error   │  (with last_error message)
                 └───────────┘  └────┬─────┘
                                     │ next /events/node for same id
                                     ▼
                                 [back to pending, error reset]
```

### Hybrid retrieval flow (per query)

```
search(query, filters)
   │
   ▼  embed(query) ──────────► query_vec
   │
   ▼  lancedb.search(query, query_type="hybrid", vec=query_vec, ...)
   │     │
   │     ├──► FTS branch (lance-native, BM25)
   │     ├──► vector branch (cosine, ANN)
   │     └──► RRF reranker (lancedb default)  ──► top-K candidates (K=15)
   ▼
cross-encoder rerank (optimum.onnxruntime, int8)
   │
   ▼
filter against cognios.db (drop deleted ids)  *(stale-id contract: see Risks)*
   │
   ▼
{ results: [...], degraded: false, partial: null }
```

When `embedding.state != "ready"`, the embed step is skipped, the lancedb call uses `query_type="fts"`, and the result envelope sets `degraded: true`.

## Implementation Units

### Phase 0 — De-risk before building

- [x] **Unit 0: PyInstaller packaging spike (completed 2026-04-26)**

  **Goal:** Prove the deep-ML sidecar bundle is viable on macOS arm64 *before* writing any indexing or retrieval code.

  **Status:** Done. Spike v1 lives at `sidecar/spike/`; full findings at [sidecar/spike/README.md](../../sidecar/spike/README.md). Headline: the lancedb (Rust-extension) + pyarrow + onnxruntime + pymupdf + fastapi + uvicorn core bundles cleanly to 335 MB with `--collect-all numpy` (mandatory for numpy 2.x — F-3); wall-clock cold-start is 1.16 s warm-cache, in-process import 61 ms; ONNX Runtime `CoreMLExecutionProvider` is reachable inside the bundle (Metal acceleration confirmed for Phase 2's <300 ms target).

  **Decisions resulting from the spike:**
  - **F-1 resolved → switch to `llama-server` out-of-process** for Gemma captioning. `llama-cpp-python` is sdist-only on PyPI for all platforms and requires `cmake` + `xcode-select` source build. The official llama.cpp `llama-server` binary publishes prebuilt artifacts for every v1 target. See Key Technical Decisions and Unit 4.
  - **F-3 → mandatory `--collect-all numpy`** added to Unit 12's PyInstaller invocation.
  - **F-2 → `cmake` + `xcode-select` are no longer required** as developer prereqs (the only consumer was `llama-cpp-python`, now removed from the sidecar).

  **Spike v2 priorities** (run before Unit 12 finalises):
  1. End-to-end captioning round-trip via `llama-server` — bundle the binary, boot it, send a base64-encoded image to `/v1/chat/completions`, confirm Gemma 3n vision works.
  2. Bundle transformers + `optimum.onnxruntime` + paddleocr-onnx into the spike — confirm the embedding/reranker/OCR layer survives PyInstaller. (Spike v1 deferred these.)
  3. Cold-disk-cache boot time (requires `sudo purge` on a clean machine) — feeds the supervisor's 30 s startup budget tuning.

### Phase 1 — Sidecar foundations

- [ ] **Unit 1: Close VFS event-emission gaps**

  **Goal:** Every node mutation that affects search-relevant content fires a `vfs://changed` event so a future sidecar subscriber stays in sync. Today notes/mutations/create_folder paths return a snapshot but do not emit; this unit closes that gap as a prerequisite for the sidecar.

  **Requirements:** R10 (background pipeline trigger), R12 (deletion cleanup), R23 (durability after restart).

  **Dependencies:** None — this is a small, self-contained Rust change.

  **Files:**
  - Modify: `src-tauri/src/services/notes/create_note.rs`
  - Modify: `src-tauri/src/services/notes/save_note_content.rs`
  - Modify: `src-tauri/src/services/mutations/delete_node.rs`
  - Modify: `src-tauri/src/services/mutations/rename_node.rs`
  - Modify: `src-tauri/src/commands/mod.rs` (the `create_folder` command)
  - Modify: `src-tauri/src/lib.rs` (thread the existing emitter into the new call sites)
  - Test: `src-tauri/tests/vfs_events.rs` (new file)

  **Approach:**
  - **AppState change.** Today `AppState` (`src-tauri/src/lib.rs:20-25`) holds `db_path`, `storage_dir`, `mount_watchers`, `url_jobs` — no emitter. Today's mutation commands (`commands/notes.rs`, `commands/nodes.rs`, `commands/mod.rs::create_folder`) take only `state: State<'_, AppState>`, not `AppHandle`. Decision: add an `emitter: Arc<dyn Fn(VfsChangeEvent) + Send + Sync>` field to `AppState`, populated in `setup()` from the existing `app_handle.emit(...)` closure. Mutation services accept `&AppState` and call `(state.emitter)(event)`. This avoids changing every command signature to thread `AppHandle` through.
  - Reasons to add to the existing `VfsChangeEvent.reason` taxonomy: `"node-created"`, `"node-saved"`, `"node-deleted"`, `"node-renamed"`. The existing TS subscriber (`useExplorerEvents`) treats any event as a snapshot-refetch trigger, so adding new reasons does not break the frontend.
  - The `mount_id` field of `VfsChangeEvent` is already misnamed; do not rename it in this unit. Use the node id for note/folder events. Plan a follow-up rename in v2.
  - **Mapping to sidecar IPC contract:** the `reason` field on `VfsChangeEvent` (Rust → Tauri webview) and the `event` field on `POST /events/node` (Rust → Python sidecar) are **separate channels carrying related information**. `reason` says "what kind of change" (`"node-created"`); `event` (`"node_changed"` | `"node_deleted"`) is a coarser sidecar-side classification. The Rust supervisor maps `reason="node-deleted"` to `event="node_deleted"` and everything else to `event="node_changed"` when forwarding to the sidecar.

  **Patterns to follow:**
  - `src-tauri/src/services/url_indexing/queue.rs` for the emit-on-state-change pattern.
  - `src-tauri/src/services/mounts/watcher.rs` for the emitter closure shape.

  **Test scenarios:**
  - Happy path: creating a note via `create_note` fires exactly one event with `reason="node-created"`.
  - Happy path: saving a note fires `reason="node-saved"`.
  - Happy path: deleting a node fires `reason="node-deleted"` and the emitter receives the deleted node id (via the misnamed `mount_id` field).
  - Happy path: renaming fires `reason="node-renamed"`.
  - Happy path: `create_folder` fires `reason="node-created"`.
  - Edge: a mutation that fails before persistence (e.g. invalid name) does not fire an event.
  - Integration: `src-tauri/tests/vfs_events.rs` runs each mutation through a real `tempdir()` DB and asserts emitter invocations using a counting closure (mirror `tests/url_indexing.rs:69-120`).

  **Verification:**
  - All five mutation paths fire exactly one event on success.
  - Failure paths fire zero events.
  - Existing tests continue to pass; the existing url-indexing event reasons are unchanged.

- [ ] **Unit 2: Tauri sidecar wiring (Rust supervisor + ACL + runtime files for both children)**

  **Goal:** Two child processes are launched by Rust at app start and supervised independently: `search-sidecar` (Python; FastAPI on loopback) and `llama-server` (C++; OpenAI-compatible HTTP on a separate loopback port). Each writes its own runtime file that Rust reads to discover its port and auth token.

  **Requirements:** R10, R22, R23, security decisions (sidecar auth, scoped ACL).

  **Dependencies:** None — pure infrastructure.

  **Files:**
  - Modify: `src-tauri/tauri.conf.json` (add `bundle.externalBin` for both `search-sidecar` and `llama-server`)
  - Modify: `src-tauri/capabilities/default.json` (add scoped `shell:allow-execute` and `shell:allow-spawn` entries for both binaries)
  - Create: `src-tauri/src/services/search/mod.rs`
  - Create: `src-tauri/src/services/search/supervisor.rs` (generic supervisor; spawns and supervises both children)
  - Create: `src-tauri/src/services/search/runtime_file.rs`
  - Modify: `src-tauri/src/lib.rs` (spawn supervisor in `setup`, register state, attach kill on window-close)
  - Modify: `src-tauri/Cargo.toml` (only if a new crate is needed; reqwest is already in deps; add `rand = "0.8"` for token generation if not transitively pulled in)
  - Create: `src-tauri/binaries/.gitkeep` (directory placeholder; real binaries placed by CI from Unit 12 or by a developer-side build script for local dev)
  - Test: `src-tauri/tests/sidecar_supervisor.rs` (new)

  **Approach:**
  - Capability scope (two parallel entries — one per binary):
    ```json
    { "identifier": "shell:allow-execute",
      "allow": [
        { "name": "binaries/search-sidecar", "sidecar": true,
          "args": ["serve", "--storage-dir", { "validator": "^/[^\\x00]+$" }] },
        { "name": "binaries/llama-server", "sidecar": true,
          "args": [
            "--host", "127.0.0.1",
            "--port", "0",
            "-m", { "validator": "^/[^\\x00]+\\.gguf$" },
            "--mmproj", { "validator": "^/[^\\x00]+\\.gguf$" },
            "--api-key", { "validator": "^[0-9a-f]{64}$" },
            "--ctx-size", { "validator": "^[0-9]{1,5}$" },
            "--parallel", { "validator": "^[1-4]$" }
          ] }
      ] }
    ```
    Add a parallel `shell:allow-spawn` block with the same two entries.
  - `bundle.externalBin: ["binaries/search-sidecar", "binaries/llama-server"]` (no platform suffix on either; Tauri appends `-<host-tuple>` when resolving siblings).
  - **Supervisor** is generic over child type. It tracks two `CommandChild` handles in `Arc<Mutex<...>>`. Spawn order: `search-sidecar` first; once Rust reads its runtime file and confirms `/healthz`, the supervisor spawns `llama-server` and writes its `(port, api-key)` to a second runtime file (`~/.cogios/search/llama-server.runtime`, mode 0600). The Python sidecar reads the llama-server runtime file when it needs to make caption calls.
  - **Restart budget per child.** Each child has its own exponential-backoff (1 s → 2 s → 4 s) up to 3 attempts. `search-sidecar` failure → "search unavailable"; `llama-server` failure → captioning disabled, OCR continues, search remains available.
  - Runtime file: 256-bit token via `rand::random::<[u8; 32]>()` (or `tauri::utils::random`), serialised JSON `{ "port": u16, "token": "<hex>" }`, written by the *sidecar* (Unit 3) to `~/.cogios/search/sidecar.runtime` with mode 0600. Rust polls for the file (1 s ticks, 30 s timeout); the path of "Rust starts the sidecar, sidecar writes the file, Rust reads it" is the sequencing.
  - Sentinel: on sidecar startup, if `sidecar.runtime` already exists, the new sidecar instance overwrites it. On clean shutdown the supervisor deletes the file.
  - The Rust HTTP client (a thin wrapper around `reqwest::blocking`) reads `port` + `token` once, caches in memory, and re-reads on supervisor restart.

  **Patterns to follow:**
  - `src-tauri/src/services/url_indexing/queue.rs` for the supervisor's state-shared-via-Arc<Mutex<...>> pattern.
  - The existing `tauri-plugin-shell` registration in `src-tauri/src/lib.rs:35`.
  - For the HTTP client, mirror `src-tauri/src/services/url_indexing/pipelines/default_web.rs` use of `reqwest::blocking`.

  **Test scenarios:**
  - Happy path: supervisor spawns both stub binaries; Rust reads each runtime file; an authenticated request to each round-trips successfully.
  - Edge: `search-sidecar` stub exits immediately — supervisor reports failure after the configured retry budget; `llama-server` is never started (search-sidecar is the prerequisite).
  - Edge: `llama-server` stub fails to start (e.g. missing GGUF) — search-sidecar continues serving FTS/vector results; the captioning role is reported as `unavailable` via `/models/status`.
  - Edge: stub binary that writes the runtime file with mode 0644 — Rust logs a warning but proceeds (mode is the sidecar's responsibility, not Rust's gate).
  - Error: missing `binaries/search-sidecar-<host-tuple>` — Rust surfaces a typed "search unavailable" error rather than panicking.
  - Error: missing `binaries/llama-server-<host-tuple>` — search continues; captioning disabled with a typed status.
  - Error: orphaned runtime file from a previous crashed run — sidecar overwrites it; Rust's cached token is invalidated and re-read.
  - Integration: full app start → both child processes visible in process table → `child.kill()` for each on app shutdown removes them.

  **Verification:**
  - Sidecar process is launched on app start and killed on app close.
  - `sidecar.runtime` contains a port + token; Rust can issue an authenticated request that the sidecar accepts.
  - On forced sidecar exit, restart fires after backoff. After 3 failed attempts, the UI receives an "unavailable" status via `GET /healthz` returning network error mapped to a typed envelope.

- [ ] **Unit 3: Python sidecar skeleton (FastAPI + bearer auth + healthz)**

  **Goal:** A buildable Python sidecar that, when spawned, binds 127.0.0.1, generates a bearer token, writes `sidecar.runtime`, and answers `GET /healthz` with a `{state: "initialising"}` payload until the indexing/model layers (Units 4-6) come online.

  **Requirements:** R10, R22, R23.

  **Dependencies:** Unit 2 (the Rust supervisor needs something to spawn).

  **Files:**
  - Create: `sidecar/pyproject.toml` (declares the `search-sidecar` console-script entry point)
  - Create: `sidecar/search_sidecar/__init__.py`
  - Create: `sidecar/search_sidecar/__main__.py` (argparse entry point: `serve --storage-dir <path>`)
  - Create: `sidecar/search_sidecar/app.py` (FastAPI app + healthz route)
  - Create: `sidecar/search_sidecar/auth.py` (token generation; bearer middleware)
  - Create: `sidecar/search_sidecar/runtime_file.py` (atomic write with mode 0600)
  - Create: `sidecar/search_sidecar/lifecycle.py` (port allocation, startup ordering, runtime-file write, log setup)
  - Create: `sidecar/tests/test_auth.py`
  - Create: `sidecar/tests/test_lifecycle.py`
  - Create: `sidecar/tests/test_healthz.py`

  **Approach:**
  - Entry point: `python -m search_sidecar serve --storage-dir ~/.cogios` (also installable as a `search-sidecar` script via `pyproject.toml`).
  - Port allocation: bind `127.0.0.1:0`, capture the OS-assigned port from the socket, write it (along with the token) to `sidecar.runtime` *before* uvicorn enters its accept loop. Sequencing matters — Rust's poll for the file must succeed only when the sidecar is actually accepting requests.
  - Bearer middleware: rejects any request without `Authorization: Bearer <token>` matching the in-memory token. Constant-time comparison via `hmac.compare_digest`.
  - Logging: structured JSON to `~/.cogios/search/sidecar.log` (file rotation deferred). FastAPI request logger redacts the `Authorization` header.
  - `GET /healthz`: returns `{state: "initialising", models: {}, queue_depth: 0}` until later units fill in the dependent subsystems.

  **Patterns to follow:**
  - This is a new component; the convention will be "single FastAPI app, one router per domain" (`routes/health.py`, `routes/search.py`, `routes/index.py`, `routes/models.py`) added in later units.

  **Test scenarios:**
  - Happy path: `serve --storage-dir <tmp>` writes a runtime file with valid JSON; the file is mode 0600 on POSIX systems.
  - Happy path: `GET /healthz` with a valid bearer token returns 200 and `state="initialising"`.
  - Error: `GET /healthz` without an Authorization header returns 401 with a redacted error envelope.
  - Error: `GET /healthz` with a wrong token returns 401.
  - Edge: an existing `sidecar.runtime` from a prior run is overwritten without raising.
  - Integration: end-to-end via `httpx.AsyncClient` against the live FastAPI app inside `pytest`.

  **Verification:**
  - `python -m search_sidecar serve --storage-dir <tmp>` starts and writes a valid runtime file.
  - Rust's supervisor (Unit 2) connects to the sidecar and gets a 200 from `/healthz`.
  - Bearer auth rejects unauthenticated requests.

### Phase 2 — Indexing

- [ ] **Unit 4: ModelManager (download + commit pin + SHA-256 + status)**

  **Goal:** Pre-shipped manifests of `(role, repo, commit, sha256)` drive a downloader that fetches model files into `~/.cogios/search/models/<role>/<commit>/`, verifies SHA-256 before activating, and exposes status + progress over HTTP/SSE. Includes Gemma license-acceptance gate.

  **Requirements:** R19, R20, security decisions (model integrity).

  **Dependencies:** Unit 3 (FastAPI app exists).

  **Files:**
  - Create: `sidecar/search_sidecar/models/__init__.py`
  - Create: `sidecar/search_sidecar/models/manifest.py` (built-in manifest of default models with commit hashes + per-file SHA-256)
  - Create: `sidecar/search_sidecar/models/manager.py` (download + verify + activate)
  - Create: `sidecar/search_sidecar/models/registry.py` (in-memory state per role)
  - Create: `sidecar/search_sidecar/routes/models.py` (status, download, select)
  - Modify: `sidecar/search_sidecar/app.py` (mount the new router)
  - Create: `sidecar/tests/test_model_manager.py`
  - Create: `sidecar/tests/test_model_routes.py`

  **Approach:**
  - Manifest is a frozen Python module shipped with the sidecar:
    ```
    DEFAULTS = {
      "embedding": ModelSpec(repo="onnx-community/gte-multilingual-base",
                             commit="<pinned>", files={"model_int8.onnx": "<sha256>", ...}),
      "reranker":  ModelSpec(repo="onnx-community/gte-multilingual-reranker-base", ...),
      "ocr":       ModelSpec(repo="PaddlePaddle/PP-OCRv4_mobile_det", ...),  # plus rec/cls
      "captioner": ModelSpec(repo="unsloth/gemma-3n-E2B-it-GGUF",
                             commit="<pinned>",
                             files={
                               "gemma-3n-E2B-it-Q4_K_M.gguf":  "<sha256>",
                               "mmproj-gemma-3n-E2B-it-f16.gguf": "<sha256>",  # vision projection head
                             },
                             license="gemma", requires_acceptance=True),
    }
    ```
    The exact commit hashes and SHA-256 values are fetched at plan-implementation time (deferred to implementation — mirror current HF state). **Captioner downloads only the GGUF weights** (model + mmproj). The `llama-server` binary itself is **not** managed by ModelManager — it is bundled in the installer at `src-tauri/binaries/llama-server-<host-tuple>` (Unit 12). When `captioner` is selected and weights are ready, Unit 2's supervisor spawns `llama-server` with `-m <model-path> --mmproj <mmproj-path>` arguments.
  - Download: HTTP GET with `Range: bytes=...` for resume support. Files written to a `tmp/` directory inside the role folder, renamed atomically after SHA-256 verification.
  - Activation: a `current` symlink (or sentinel file on Windows in v2) in `~/.cogios/search/models/<role>/` points at the verified commit folder. Cold-start reads the symlink target.
  - Gemma license gate: `models/select` for `role="captioner"` rejects with `licenseAccepted: false` until the UI calls `models/accept-license` with the role; the manager records acceptance in `~/.cogios/search/models/captioner/license.accepted`. **Critical: HuggingFace gating.** Both `google/gemma-3n-E2B-it` and `unsloth/gemma-3n-E2B-it-GGUF` are gated repos on HuggingFace — downloading them requires an HF account that has accepted the Gemma TOS at huggingface.co AND an HF auth token. The plan's local `license.accepted` sentinel does not bypass this. v1 design: the LicenseAcceptanceModal (Unit 10) collects the user's HF token (linked from the modal text "Sign in to HuggingFace and accept the Gemma terms; paste your token below"); the token is stored in OS keychain (same path as API keys); ModelManager reads it at download time and sends `Authorization: Bearer <hf_token>` to HuggingFace. If the user declines, the captioner stays unconfigured and image-caption indexing is disabled (OCR alone runs). This must be wired before the captioner can be downloaded.
  - SSE progress: `POST /models/download` returns a streaming response of `{role, bytes_downloaded, bytes_total, state}` events.
  - **Idempotent license acceptance.** `POST /models/accept-license` is safe to call repeatedly; subsequent calls return `{accepted: true}` without rewriting the sentinel. The acceptance persists across sidecar restarts (verified by Unit 4 test scenarios).

  **Patterns to follow:**
  - The existing url_indexing fetcher (`src-tauri/src/services/url_indexing/pipelines/default_web.rs`) for the pattern of "fetch → verify → write → atomic rename".
  - Within Python: `requests` is the simplest HTTP client; `httpx` is also acceptable. Pick one and stick with it across the sidecar.

  **Test scenarios:**
  - Happy path: download with a fixture HTTP server returning a known small file; SHA-256 matches; the file ends up under the commit folder.
  - Happy path: `GET /models/status` returns `{embedding: {state: "ready"}, ...}` after activation.
  - Happy path: `POST /models/download` streams progress events as the download proceeds.
  - Edge: download is interrupted at byte N and resumed via Range; final file passes SHA-256.
  - Error: SHA-256 mismatch — file is deleted; status transitions to `error` with `{reason: "sha256_mismatch"}`.
  - Error: HTTP 404 from upstream — status transitions to `error` with `{reason: "not_found"}`.
  - Error: requesting `/models/select` with `role="captioner"` before license acceptance — returns 409 with `{code: "license_not_accepted"}`.
  - Edge: orphaned `tmp/` files from a prior crashed download — cleaned up at next download attempt.

  **Verification:**
  - Models can be downloaded, verified, and activated end-to-end against a fixture.
  - Gemma cannot be downloaded without explicit license acceptance.
  - `GET /models/status` reflects truth across the four roles.

- [ ] **Unit 5: Indexing pipeline (per-content-type processors + queue + error isolation)**

  **Goal:** A background queue inside the sidecar consumes `POST /events/node` events, dispatches each node through the right processor (text / PDF / image / URL-cache), produces `(text, vec)` rows, and persists them. Per-job timeouts and try/except fences keep one bad file from poisoning the queue.

  **Requirements:** R7, R8, R10, R12, R13, R13+.

  **Dependencies:** Unit 4 (models loaded), Unit 6 partial (lancedb table available — sequence so this unit consumes the lancedb client).

  **Files:**
  - Create: `sidecar/search_sidecar/index/__init__.py`
  - Create: `sidecar/search_sidecar/index/queue.py` (SQLite-backed persistent queue; `enqueue`, `dequeue`, `mark_indexed`, `mark_error`)
  - Create: `sidecar/search_sidecar/index/runner.py` (worker pool: 1 worker for OCR/caption, N for text)
  - Create: `sidecar/search_sidecar/index/processors/__init__.py`
  - Create: `sidecar/search_sidecar/index/processors/text.py` (note + .md/.mdx/.txt direct read)
  - Create: `sidecar/search_sidecar/index/processors/pdf.py` (PyMuPDF + per-page OCR fallback)
  - Create: `sidecar/search_sidecar/index/processors/image.py` (OCR + caption in parallel)
  - Create: `sidecar/search_sidecar/index/processors/url_cache.py` (read pre-stripped text from Rust's `url_jobs.html_cache_path`)
  - Create: `sidecar/search_sidecar/index/dispatch.py` (kind + extension → processor)
  - Create: `sidecar/search_sidecar/routes/events.py` (POST /events/node)
  - Create: `sidecar/search_sidecar/routes/index.py` (GET /index/status, GET /index/status/<id>)
  - Modify: `sidecar/search_sidecar/app.py` (mount routers)
  - Create: `sidecar/tests/test_queue.py`
  - Create: `sidecar/tests/test_processors_text.py`
  - Create: `sidecar/tests/test_processors_pdf.py`
  - Create: `sidecar/tests/test_processors_image.py`
  - Create: `sidecar/tests/test_processors_url_cache.py`
  - Create: `sidecar/tests/test_runner_isolation.py`

  **Approach:**
  - Queue table (`queue.db`):
    ```
    CREATE TABLE jobs (
      node_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      absolute_content_path TEXT,
      state TEXT NOT NULL,             -- pending|indexing|indexed|error
      indexed_at TEXT,
      last_error TEXT,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_jobs_state ON jobs(state);
    ```
  - **Database hardening.** Open `queue.db` with `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA foreign_keys=ON`. Run `PRAGMA quick_check` at sidecar startup; on failure (corruption from a hard kill mid-write), rename the corrupt file to `queue.db.corrupt-<timestamp>`, recreate the schema empty, and trigger a fresh resync from Rust (`POST /events/resync` is idempotent). This recovers without losing the search experience — lancedb still has indexed content; only the queue state is rebuilt.
  - Resume on startup: any rows in `state="indexing"` are reset to `pending` (mirrors `requeue_stale_jobs`).
  - Worker pool: a single worker for OCR/caption (memory-bound — Gemma + paddleocr-onnx loaded together push past 2 GB), N=4 workers for text/PDF/url_cache. The dispatch table chooses the worker pool by content type.
  - Per-job timeout: 60 s default, 300 s for image OCR; image captioning is bounded by an HTTP-level timeout on the call to `llama-server` (default 240 s). **In-sidecar implementation: subprocess isolation for the heavy in-process worker (OCR), not threading.** OCR runs as a separate child process (via `multiprocessing.Process`); the runner sends `SIGTERM` after timeout and `SIGKILL` after a grace period. `signal.alarm` is **not viable** because it only fires on the main Python thread and FastAPI/uvicorn worker pools run handlers on threadpool workers; `threading.Timer` + cooperative cancellation cannot interrupt PyMuPDF native calls. The captioner's KV-cache growth is solved by Unit 2's `llama-server` process recycling (every 200 captions or 30 minutes); the search-sidecar never sees that growth.
  - Error isolation: every processor runs inside a try/except that converts any exception to `mark_error(node_id, str(e))`. PyMuPDF and llama.cpp can crash on malformed input; the wrapper catches `BaseException` for those calls.
  - Per-content-type pipelines:
    - text: read file → chunk → embed batch → upsert to lancedb.
    - PDF: PyMuPDF page text; if a page returns empty text, fall back to per-page OCR; chunk → embed → upsert.
    - image: parallel OCR (paddleocr-onnx, in-process) and caption (HTTP POST to the local `llama-server` `/v1/chat/completions` endpoint with the image as a base64-encoded `image_url` content part). Concatenate `"OCR: <text>\nCaption: <caption>"` as the document text. If either pipeline fails the other still indexes; both failing → error state. The caption HTTP client honours the same `Authorization: Bearer <api-key>` scheme as the search-sidecar's own auth, reading the `(port, api-key)` from `~/.cogios/search/llama-server.runtime` (mode 0600, written by Rust at supervisor startup).
    - url_cache: read `html_cache_path` from Rust event payload. **Important — the cache file contains raw HTML, not stripped text.** `src-tauri/src/services/url_indexing/cache.rs::write_html_cache` writes the raw `html` string from `PipelineOutput`; only the 320-char `preview_text` is stripped (and that lives in `cognios.db`'s `url_jobs.preview_text`, not in the cache file). The sidecar must therefore strip HTML itself. Add `selectolax` (fast, lxml-based, ~5 MB wheel) to the Python deps for this. Fall back to using the truncated `preview_text` (forwarded via the IPC event payload) only if the cache file is missing.
  - Memory cap for the **search-sidecar** itself: best-effort `RLIMIT_AS` on Linux (set to 6 GB at startup); not enforced on Darwin (the kernel ignores `RLIMIT_AS` for most processes). The captioner is no longer in-process so its memory is irrelevant to the search-sidecar's bound; OCR is the only heavy in-process workload, and its memory is bounded by per-job timeouts.
  - **Captioner process recycling.** The `llama-server` child has its own KV cache that grows over the lifetime of the process. Unit 2's supervisor recycles `llama-server` every 200 caption requests (or every 30 minutes of uptime, whichever first): SIGTERM the current process, wait for in-flight requests to drain (~5 s grace), respawn with the same model paths. Process isolation makes this trivial — the search-sidecar never sees the recycle event.

  **Patterns to follow:**
  - The Rust url_indexing queue (`src-tauri/src/services/url_indexing/queue.rs`) for state transitions and crash-resume semantics.
  - The Rust mutation services (`src-tauri/src/services/notes/`) for the "transactional persist + emit" pattern.

  **Test scenarios:**
  - Happy path (text): a `.md` file path is enqueued; processor reads, chunks, calls a stub embedder, and writes 3 rows to a stub lancedb table.
  - Happy path (image): a fixture `.png` produces both OCR text and a captioner output; both feed into the indexed document.
  - Happy path (PDF): a text-based PDF extracts text; a scanned-image PDF triggers per-page OCR fallback.
  - Happy path (url_cache): the stored `html_cache_path` is read and indexed.
  - Edge: `kind=note`, body empty — node is marked `indexed` with zero rows, no error.
  - Edge: incoming `event=deleted` for an unknown node id — no-op (idempotent).
  - Edge: re-enqueue while a job is already `indexing` — the new event resets `attempts`, the in-flight job continues; on completion it picks up the new event.
  - Error: malformed PDF — caught by the wrapper, node marked `error`, queue continues.
  - Error: OCR raises — image's caption still indexes (partial success), node marked `indexed` with a degraded flag in `last_error`.
  - Error: both OCR and caption fail — node marked `error`.
  - Error: timeout (job exceeds 300 s) — node marked `error` with `reason="timeout"`.
  - Integration: `test_runner_isolation.py` enqueues 50 jobs including 2 deliberately broken ones; the queue completes the other 48 and isolates the 2 in `error` state.

  **Verification:**
  - Each processor produces deterministic output for a fixture.
  - Queue state transitions are persisted and resume-correct after a simulated crash (kill the worker mid-job, restart, observe re-pending → indexed).
  - Memory usage per OCR/caption job stays under the 6 GB cap.
  - `GET /index/status` reflects accurate queue depth.

- [ ] **Unit 6: lancedb hybrid storage + retrieval (FTS + vector + rerank)**

  **Goal:** lancedb table set up for hybrid retrieval; embedding writes feed it; the search API runs `query_type="hybrid"` + cross-encoder rerank and returns the result envelope. FTS-only fallback is in place when the embedding model is not ready.

  **Requirements:** R1, R2, R3, R4 (with FTS-only fallback).

  **Dependencies:** Unit 4 (embedding + reranker models), Unit 3 (FastAPI shell).

  **Files:**
  - Create: `sidecar/search_sidecar/storage/__init__.py`
  - Create: `sidecar/search_sidecar/storage/lancedb_store.py` (open/create table, schema, upsert, search, delete)
  - Create: `sidecar/search_sidecar/embeddings/__init__.py`
  - Create: `sidecar/search_sidecar/embeddings/gte.py` (loads `model_int8.onnx` via `optimum.onnxruntime`)
  - Create: `sidecar/search_sidecar/rerank/__init__.py`
  - Create: `sidecar/search_sidecar/rerank/gte_reranker.py` (loads reranker int8 ONNX)
  - Create: `sidecar/search_sidecar/retrieval/__init__.py`
  - Create: `sidecar/search_sidecar/retrieval/search.py` (orchestrator: hybrid → rerank → envelope)
  - Create: `sidecar/search_sidecar/routes/search.py` (POST /search)
  - Modify: `sidecar/search_sidecar/app.py` (mount router)
  - Create: `sidecar/tests/test_lancedb_store.py`
  - Create: `sidecar/tests/test_search_orchestrator.py`
  - Create: `sidecar/tests/test_fts_fallback.py`

  **Approach:**
  - **Note: schema + upsert + delete live in `lancedb_store.py` and are needed by Unit 5's processors.** Sequence the implementation so that `lancedb_store.py` (schema, `upsert(rows)`, `delete_by_node_id(node_id)`) ships at the start of Unit 6 and is consumed by Unit 5's processors as a dependency. Hybrid retrieval, FTS-only fallback, the cross-encoder reranker, and the `/search` endpoint are the rest of Unit 6 and may follow Unit 5. Without this split the two units have a circular dependency.
  - Schema (one lancedb table named `nodes`):
    ```
    id TEXT          # synthetic chunk id: "<node_id>:<chunk_idx>"
    node_id TEXT     # parent node
    kind TEXT
    name TEXT
    text TEXT        # chunk text
    vector list<float32, 768>
    mount_id TEXT?
    created_at TIMESTAMP
    modified_at TIMESTAMP
    ```
  - Indexes:
    - `tbl.create_fts_index("text", use_tantivy=False)` (lance-native FTS)
    - `tbl.create_index(metric="cosine")` (vector ANN)
    - `tbl.create_scalar_index("node_id")` (for delete-by-node speed)
  - Upsert: write per chunk; on `event=deleted` call `tbl.delete(f"node_id = '{node_id}'")`.
  - Hybrid search: **over-fetch then aggregate then trim.** Call `tbl.search(query, query_type="hybrid", vec=query_vec).where(filter_sql).limit(200).to_list()` — *200, not 15*. Aggregate per-`node_id` in-memory (take MAX(score), retain the highest-scoring chunk's text as snippet). Trim to top 15 nodes. Then run the cross-encoder rerank on those 15 nodes. This avoids a known lancedb issue where the FTS+scalar-index+filter combo can drop matches when `prefilter=True`, and ensures per-node aggregation cannot collapse the result list below the user-visible cap. ([lancedb #1656](https://github.com/lancedb/lancedb/issues/1656).)
  - **SQL injection guard for filter and delete paths.** The brainstorm's example `tbl.delete(f"node_id = '{node_id}'")` and the filter-to-SQL parser must treat all interpolated values as untrusted: validate `node_id` as UUID-format (regex `^[0-9a-f-]{36}$`) at the `POST /events/node` Pydantic model boundary; restrict `kind` filter to a strict allowlist (`note|file|url|folder|mount|directory`); escape single quotes in mount-name values (or restrict mount IDs to UUIDs and resolve names server-side). Lancedb's Python API does not currently expose parameterized predicates, so allowlist + escape is the substitute.
  - **Date filter UTC normalization.** Date filters (`created:7d`, `created:>2026-01-01`, etc.) are converted to absolute UTC strings at the **Rust IPC boundary** (e.g., `created:7d` → `created_at > '2026-04-19T00:00:00Z'`), not in lancedb SQL. This avoids cross-process clock-drift bugs (Rust's wall clock vs. Python's `NOW()`), and DST/timezone surprises. All timestamps in the IPC event payload are RFC3339 UTC strings; lancedb stores TIMESTAMPS as UTC throughout.
  - FTS fallback: if `embedding.state != "ready"`, call `tbl.search(query, query_type="fts").where(filter_sql).limit(200)`, aggregate per-node, trim to 15, and **skip the cross-encoder**. Set `degraded: true` in the envelope.

  **Patterns to follow:**
  - This is a new component; future Python search/retrieval logic should mirror its `retrieval/search.py` orchestrator pattern.

  **Test scenarios:**
  - Happy path: upsert 10 fixture documents; query returns relevance-ordered results matching expectations.
  - Happy path: hybrid query returns docs that match semantically (no literal keyword overlap) — verifies the embedding path is wired.
  - Happy path: FTS-only fallback returns keyword-only matches when the embedding model is forced to `state=missing`.
  - Edge: empty query returns empty result list with `degraded: false` (or 400 if we want to reject; pick "empty list" for graceful frontend handling — confirm in implementation).
  - Edge: filter `kind:note,url` → only those kinds returned.
  - Edge: filter `mount:foo` → only nodes under that mount.
  - Edge: invalid filter syntax (`kind:` with no value) — falls through as plain query text per R6.
  - Edge: date filter `created:7d` resolves correctly relative to current time.
  - Edge: per-node aggregation collapses multiple chunk hits into one row using the highest-scoring chunk's snippet.
  - Edge: deletion via `tbl.delete("node_id = ...")` removes all chunks for that node.
  - Error: lancedb operation fails (e.g. table corrupt) — search returns `{ok: false, error: {code: "store_error"}}`, sidecar does not crash.
  - Integration: `test_search_orchestrator.py` indexes 5 fixtures, queries with each filter combination, asserts envelope shape + `degraded: false`.
  - Integration: `test_fts_fallback.py` forces embedding to `missing`, runs the same fixtures, asserts `degraded: true` and FTS-style ordering.

  **Verification:**
  - End-to-end search returns within ~300ms p95 for the 500-document fixture (the brainstorm's success criterion).
  - Per-node aggregation is correct.
  - FTS-only fallback returns useful results without the embedding model.
  - Deletion removes all chunks.

### Phase 3 — Retrieval API

- [ ] **Unit 7: Search IPC contract (Rust commands + TS client)**

  **Goal:** New Rust commands `search_query`, `get_indexing_status`, `get_indexing_status_by_id`, `get_models_status`, `models_select_provider` (and HTTP-event proxies for the indexer) wrap the sidecar HTTP API; TS-side typed client uses them. Filter parsing happens in the sidecar (single source of truth).

  **Requirements:** R1, R2, R3, R5, R5+, R6, R11, R16.

  **Dependencies:** Unit 6 (search endpoint exists), Unit 5 (status endpoint exists), Unit 4 (models endpoint exists), Unit 2 (Rust HTTP client wired).

  **Files:**
  - Create: `src-tauri/src/services/search/client.rs` (HTTP client: read sidecar.runtime, attach bearer, handle retry-on-restart)
  - Create: `src-tauri/src/commands/search.rs`
  - Modify: `src-tauri/src/commands/mod.rs` (re-export)
  - Modify: `src-tauri/src/lib.rs` (register commands in `invoke_handler!`)
  - Create: `src/lib/contracts/search.ts` (mirror sidecar response types)
  - Modify: `src/lib/tauri/ipc.ts` (add `searchQuery`, `getIndexingStatus`, etc.)
  - Create: `src/features/search/api/searchClient.ts` (interface + binding mirror of `explorerClient`)
  - Create: `src/features/search/types/search.ts` (shared types)
  - Create: `src-tauri/tests/search_commands.rs`
  - Create: `src/features/search/api/searchClient.test.ts`

  **Approach:**
  - Rust command shape (mirror the existing pattern in `src-tauri/src/commands/notes.rs`):
    ```rust
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SearchQueryInput { query: String, filters: Option<SearchFilters>, limit: Option<u32>, cursor: Option<String> }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SearchResponseDto { results: Vec<SearchResultDto>, degraded: bool, partial: Option<PartialIndexDto> }
    ```
  - The HTTP client's failure modes:
    - sidecar unavailable (no runtime file, supervisor in retry loop) → return `{state: "unavailable"}` envelope, do not propagate the network error to the UI as an unhandled exception.
    - sidecar returns 503 with `state: "initialising"` → return that envelope verbatim; UI shows the cold-start hint.
    - sidecar 401 → invalidate cached token and retry once (handles a sidecar restart with fresh token).
  - On `event=deleted` for the search index, Rust forwards the existing `vfs://changed` event payload via `POST /events/node` (one-shot, ignore the response, log on failure — the sidecar will eventually catch up via a periodic resync if needed; that resync mechanism is deferred to v1b).
  - Filters are not parsed in Rust — the sidecar parses, and the TS client renders the filter pickers (Unit 9) into the same query string + filter object schema.

  **Patterns to follow:**
  - `src-tauri/src/commands/urls.rs` for command + DTO shape.
  - `src/lib/tauri/ipc.ts` for the typed wrapper.
  - `src/features/explorer/api/explorerClient.ts` for the feature-scoped client interface that tests can mock.

  **Test scenarios:**
  - Happy path: `searchQuery({query: "oauth"})` returns a typed result list.
  - Happy path: `getIndexingStatus()` returns queue depth.
  - Edge: sidecar returns `degraded: true` — TS client surfaces it; the UI consumer reads it (Units 8/9 verify the visual).
  - Edge: sidecar returns 503 with `state: "initialising"` — Rust client maps to a typed envelope; TS receives `{state: "initialising"}` not a thrown error.
  - Error: sidecar process is dead (no runtime file) — Rust client returns `{state: "unavailable"}`.
  - Error: stale cached token — first request gets 401, second succeeds after re-read.
  - Integration: `src-tauri/tests/search_commands.rs` runs against a fixture FastAPI sidecar (test harness binary) and asserts each command's contract.

  **Verification:**
  - All commands round-trip through the sidecar in dev mode.
  - Token-refresh-on-401 works when the sidecar is restarted mid-session.
  - The TS client is fully typed; result fields are exactly what the sidecar contract specifies.

### Phase 4 — UI Surfaces

- [ ] **Unit 8: Cmd+K palette (replace existing stub)**

  **Goal:** A working Cmd+K palette that replaces the placeholder in `src/app/AppSidebar.tsx`, calls `searchQuery`, renders top-15 results + the "More results" link, supports inline filter syntax, exposes a query-syntax help popover, and shows the recently-modified empty state before query input.

  **Requirements:** R14, R5 (kind/mount), R6 (silent fallthrough), R11 (status indicator surfaced).

  **Dependencies:** Unit 7 + state-hoisting prerequisite (see below).

  **Phase 4 prerequisite: hoist explorer state.** `src/features/explorer/store/useExplorerStore.ts` is a per-component React hook today; the only consumer is `ExplorerLayout.tsx`. The new `SearchPalette` renders inside `AppSidebar.tsx` (a sibling of `ExplorerLayout`) and needs to call `activateArtifact(nodeId)` to honour the activation-flow contract. Unit 9's `Cmd+Shift+F` similarly needs to set an `activeSearchView` flag visible from `App.tsx`. Hoist `useExplorerStore` to a context provider mounted at the App root, so Sidebar, Layout, and the dedicated SearchView all read the same instance. Estimate: ~50 LOC. Land this as the first commit of Phase 4 (or split as Unit 7.5 if convenient).

  **Cmd+K shortcut wiring.** No global `Cmd+K` keydown listener exists today (`AppSidebar.tsx` has a `⌘K` button label but no shortcut binding). Adding the binding is part of Unit 8's scope.

  **Files:**
  - Create: `src/features/search/components/SearchPalette.tsx`
  - Create: `src/features/search/components/SearchResultRow.tsx`
  - Create: `src/features/search/components/QuerySyntaxHelp.tsx`
  - Create: `src/features/search/hooks/useSearchPaletteState.ts` (debounce + abort prior request on new query)
  - Create: `src/features/search/hooks/useRecentNodes.ts` (top-10 most-recently-modified, derived from existing snapshot)
  - Modify: `src/app/AppSidebar.tsx` (replace stub overlay; preserve Cmd+K shortcut wiring)
  - Modify: `src/styles/app.css` (palette + result row styling; reuse existing `.modal-overlay` pattern where possible)
  - Create: `src/features/search/components/SearchPalette.test.tsx`
  - Create: `src/features/search/components/SearchResultRow.test.tsx`
  - Create: `src/features/search/hooks/useSearchPaletteState.test.ts`

  **Approach:**
  - Component skeleton mirrors `MountModal.tsx`: `<div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Search">` wrapping a `<div className="search-palette">` with input + result list.
  - ARIA: input has `role="combobox" aria-expanded aria-controls="search-results" aria-activedescendant`; result list has `role="listbox" id="search-results"`; rows are `role="option"`.
  - Live region: a `aria-live="polite"` span announces the result count when the list updates.
  - Keystroke routing:
    - Esc → close, focus returns to the previously-focused element via `useRef` + `restoreFocus()` on mount.
    - ↑/↓ → cycle the active result.
    - Enter → activate the selected node (re-uses the existing tree single-click activation flow — call into `useExplorerStore.activateArtifact(nodeId)`).
    - Any printable key while a row is selected → focus returns to input and appends the char (per UX decision in origin doc).
  - Debounce: 150 ms; the hook holds a `Cancelable` that aborts any in-flight `searchQuery` when a new query starts.
  - Empty state: when `query.trim() === ""`, render the `useRecentNodes()` output (top-10 most-recently-modified). Disambiguates from "no results" via a header label.
  - Degraded banner: when the response carries `degraded: true`, render a one-line banner "Semantic search initialising — showing keyword matches."
  - "More results" link: when results.length === 16 (sidecar returns `limit + 1` to signal more), render the link; clicking it closes the palette and dispatches a navigation event for Unit 9.

  **Snippet rendering — XSS hardening (carries forward SEC-007).** Snippets contain content from user files, OCR output of arbitrary images, and Gemma-generated captions — all untrusted text. `SearchResultRow` renders snippets via React text nodes only. **Never use `dangerouslySetInnerHTML` for snippets.** Match highlighting is applied client-side: the sidecar returns offset metadata (`{ start, end }` ranges) alongside the snippet text; the row component splits the string at those offsets and wraps each match in a `<mark>` element built via React.createElement, never via string interpolation of HTML. Same constraint applies to Unit 9's preview pane.

  **Patterns to follow:**
  - `src/features/explorer/components/MountModal.tsx` for modal shell.
  - `src/features/explorer/store/useExplorerStore.ts` for activation flow.
  - `src/features/explorer/components/ExplorerLayout.tsx` for handler wiring patterns.

  **Test scenarios:**
  - Happy path: typing "oauth" with mock client returning 3 results — rows render with correct icon/name/snippet/path.
  - Happy path: empty query state shows recent-nodes list (top 10 by modified date).
  - Happy path: ↑/↓ navigates rows; Enter activates the active row's node id.
  - Happy path: Esc closes the palette; focus returns to the previously-focused element.
  - Edge: typing while a row is selected appends to the query, focus returns to the input.
  - Edge: `degraded: true` response renders the "initialising" banner.
  - Edge: 16 results from the sidecar render 15 + a "More results" link.
  - Edge: invalid filter syntax (`kind:` with no value) — query falls through, no error UI.
  - Error: search command rejects (sidecar unavailable) — banner "Search unavailable. Retrying…" shown; no thrown exception.
  - Integration: end-to-end with a mocked search client; full keyboard navigation flow.
  - Accessibility: result list announces "X results" via the live region; combobox/listbox ARIA roles validated by `@testing-library/jest-dom`.

  **Verification:**
  - Cmd+K opens the new palette (the stub is gone).
  - Typing returns search results; Enter activates a node and closes the palette.
  - The query syntax popover is reachable via the `?` icon and lists `kind:`, `mount:`, `created:`, `modified:` with one example each.
  - Accessibility audit (`axe-core` via `@axe-core/react` if added; otherwise manual spot-check) reports no critical issues.

- [ ] **Unit 9: Dedicated search view (center pane)**

  **Goal:** A new center-pane surface (sibling of `ExplorerLayout`'s detail surface) for full-power search: filter pickers (kind multi-select, date pickers, mount picker), a longer scrollable result list, sort dropdown (relevance / modified), and a preview pane that selects-on-click.

  **Requirements:** R15, R5+ (date + mount UI), R16.

  **Dependencies:** Unit 8 (shared components: `SearchResultRow`).

  **Files:**
  - Create: `src/features/search/components/SearchView.tsx`
  - Create: `src/features/search/components/SearchFilterBar.tsx`
  - Create: `src/features/search/components/SearchPreviewPane.tsx`
  - Modify: `src/app/App.tsx` (add a `searchView` route; default Cmd+Shift+F shortcut)
  - Modify: `src/features/explorer/components/ExplorerLayout.tsx` (allow the center surface to render `SearchView` when active)
  - Modify: `src/styles/app.css` (search view layout)
  - Create: `src/features/search/components/SearchView.test.tsx`
  - Create: `src/features/search/components/SearchFilterBar.test.tsx`

  **Approach:**
  - Cmd+Shift+F opens the dedicated view by setting an `activeSearchView` flag on the explorer store; the existing three-column layout's center surface conditionally renders `<SearchView>` instead of the note-editor / markdown-preview / image-viewer.
  - Filter pickers: kind chips (multi-select), date pickers (native `<input type="date">`), mount picker (dropdown sourced from `useExplorerStore.mounts`).
  - Filters serialise into the same query-object shape the palette uses, so the same Rust command handles both.
  - Pagination: cursor-based ("Load more" button after the first 50). The sidecar's `/search` accepts a `cursor` field (deferred behaviour for the implementer to add if not in Unit 6's first cut; flag in deferred questions).
  - Preview pane: shows the selected result's content via the existing kind-specific rendering (`MarkdownPreview` for notes/.md files, `ImageViewer` for images, plain text for OCR/caption fallback).
  - Sort: relevance (default) or modified date. A simple `<select>` next to the filter bar.
  - Latency target: the 300 ms SLO does not apply to dedicated-view "Load more" calls; the first page is the same `searchQuery` call as the palette.

  **Patterns to follow:**
  - `src/features/explorer/components/ExplorerInspector.tsx` for the side-by-side layout pattern.
  - `src/features/explorer/components/MarkdownPreview.tsx` and `ImageViewer.tsx` for the preview surface.

  **Test scenarios:**
  - Happy path: opening Cmd+Shift+F replaces the center pane with `SearchView`; tree stays interactive on the left.
  - Happy path: applying a kind filter narrows results; the result list updates without reload.
  - Happy path: clicking a result row populates the preview pane.
  - Edge: empty search with all filters defaulted — results are empty list, preview is blank state.
  - Edge: sort change re-issues the search; the previous in-flight request is cancelled.
  - Edge: pagination — clicking "Load more" appends the next 50 to the existing list without resetting selection.
  - Error: sidecar unavailable — the center pane shows an inline error with a retry button; tree stays usable.
  - Integration: full keyboard navigation across the filter bar + result list (Tab moves focus through; arrows nav the result list).

  **Verification:**
  - Cmd+Shift+F opens the dedicated view.
  - Filters / sort / pagination all round-trip through the same `searchQuery` IPC.
  - Preview pane renders correctly for note / .md / image kinds.

- [ ] **Unit 10: Settings section (sidebar entry + provider config + ModelManager UI + privacy disclosure)**

  **Goal:** A new fifth section in `AppSidebar` named "Settings" hosts: per-role provider config (local vs HTTP, with API-key field stored via Tauri secure storage), ModelManager status with download progress + Switch-model action, the privacy-disclosure modal (R18+), and the Gemma license-acceptance flow.

  **Requirements:** R17, R18, R18+, R19, R20, security decisions (API key in keychain, license gate).

  **Dependencies:** Unit 4 (ModelManager exists), Unit 7 (status + select endpoints).

  **Files:**
  - Create: `src/features/settings/components/SettingsLayout.tsx`
  - Create: `src/features/settings/components/ProviderRoleCard.tsx`
  - Create: `src/features/settings/components/ProviderConfigForm.tsx`
  - Create: `src/features/settings/components/ModelManagerStatus.tsx`
  - Create: `src/features/settings/components/PrivacyDisclosureModal.tsx`
  - Create: `src/features/settings/components/LicenseAcceptanceModal.tsx`
  - Create: `src/features/settings/api/settingsClient.ts`
  - Create: `src/features/settings/hooks/useModelStatus.ts` (SSE subscription)
  - Modify: `src/app/AppSidebar.tsx` (add the fifth nav item; type `AppSection` extended with `"settings"`)
  - Modify: `src/app/App.tsx` (add `SECTION_LABELS["settings"]` + render `<SettingsLayout>` for the new section)
  - Create: `src-tauri/src/commands/secure_storage.rs` (wraps Tauri secure storage for API keys)
  - Modify: `src-tauri/Cargo.toml` (add the `keyring` crate; **not** `tauri-plugin-stronghold` — Stronghold requires a user passphrase per snapshot, intended for cryptographic key material, and is UX-hostile for OpenAI-style API keys. `keyring = "3"` wraps macOS Keychain / Windows Credential Manager / Secret Service via a single API.)
  - Modify: `src-tauri/src/lib.rs` (register secure-storage commands; bind plugin)
  - Create: `src/features/settings/components/SettingsLayout.test.tsx`
  - Create: `src/features/settings/components/ProviderConfigForm.test.tsx`
  - Create: `src/features/settings/components/ModelManagerStatus.test.tsx`
  - Create: `src-tauri/tests/secure_storage.rs`

  **Approach:**
  - **Secure storage.** API keys for HTTP providers — and the HuggingFace token for gated Gemma downloads — are stored via the OS keychain through the `keyring` crate (Tauri's Stronghold plugin is the wrong tool: it requires a user passphrase per snapshot and is intended for cryptographic key material, not user-facing API keys). The Rust command interface is `set_provider_secret(role, key)` / `get_provider_secret(role) -> Option<String>` and `set_hf_token(token)` / `get_hf_token() -> Option<String>`. Keys are referenced by role name, never persisted in `cognios.db` or settings JSON.
  - **Secret forwarding to sidecar.** When the Rust HTTP client calls into the sidecar for an embedding/rerank/caption operation that uses a remote HTTP provider, Rust pulls the secret from keychain at call time and includes it on the **outbound** call to the configured `base_url` (Rust acts as the proxy). The sidecar does **not** receive provider secrets and does **not** call HuggingFace or OpenAI-compatible endpoints directly for live inference — it only delegates the remote-inference call to Rust via a back-channel. (For model **downloads** specifically, the sidecar receives the HF token in the `POST /models/download` request body so it can stream the file with auth; the request body is over loopback only.) This keeps secrets in a single trust zone and avoids duplicating them across processes.
  - **HTTPS-only.** The Rust `set_provider_config` command rejects any `base_url` that does not begin with `https://`. The privacy-disclosure modal additionally calls out the destination scheme prominently.
  - **Log redaction.** Beyond the `Authorization` header (already redacted in Unit 3): the sidecar logger redacts/truncates `absolute_content_path` (logs `node_id` only), truncates `query` strings to ≤200 chars, caps `last_error` text written to `queue.db` at 1 KB, and creates `~/.cogios/search/` with mode 0700 at sidecar startup.
  - **Provider config form.** Inputs: type (local/http), `base_url`, `model_name`, `api_key` (write-only — the form shows "*****" after save). On save, Rust persists the non-secret fields to a settings JSON in `~/.cogios/search/providers.json`, and the secret separately to the keychain.
  - **Privacy disclosure.** When the user changes type from `local` to `http` (or changes `base_url`), modal appears: "Configuring a remote provider will send the full text of indexed content to <base_url>. Continue?". On confirm, save proceeds.
  - **License acceptance (Gemma).** Before the captioner role can be enabled, a one-shot modal shows "Google Gemma is licensed under the Gemma Terms of Use. By accepting you agree to those terms (link)." On accept, Rust calls sidecar's `models/accept-license` endpoint.
  - **Model status.** `useModelStatus()` subscribes to the sidecar's SSE progress stream via the Rust HTTP client (Rust opens the stream and re-emits Tauri events `models/progress`).

  **Patterns to follow:**
  - `src/features/explorer/components/ExplorerInspector.tsx` for the right-side panel layout (the settings layout reuses the three-column variant).
  - `src/features/explorer/components/MountModal.tsx` for the disclosure / license modals.

  **Test scenarios:**
  - Happy path: switching the embedding provider from local to HTTP triggers the privacy modal; on confirm, the form saves; on cancel, the form reverts.
  - Happy path: API key entered in the form is stored via secure storage and never echoed back; the form shows "*****".
  - Happy path: model download progress streams update the progress bar.
  - Edge: switching back from HTTP to local does not delete the keychain entry for the HTTP provider (kept for the user's convenience), but the entry is no longer queried.
  - Edge: license-acceptance modal cancel — captioner role stays disabled.
  - Error: secure-storage failure (keychain unavailable) — form shows an inline error and does not save the role config.
  - Error: `models/select` returns `licenseAccepted: false` for captioner — the license modal appears immediately.
  - Integration: after a fresh install + first-run download flow (Unit 11), the Settings page reflects each role's `ready` state.

  **Verification:**
  - The Settings section is reachable from the sidebar.
  - Provider config persists across app restarts.
  - API keys are not visible in any file under `~/.cogios/`.
  - Gemma cannot be used until license is accepted.

### Phase 4.5 — UI hardening (Unit 9 amendments)

The dedicated search view must additionally:

- **Render partial-index state.** When the response carries `partial: { indexed: N, total: M }`, show a status line in the result header: "Searching <N> of <M> indexed nodes". Same constraint as the palette (R11).
- **Specify result-row activation per kind.** Clicking a result is a "select for preview" action (populates the preview pane); the preview pane is read-only. To open a note for editing, the user clicks an "Open in editor" affordance on the preview pane, which navigates to the Explorer section and opens `NoteEditor`. URL nodes show stripped-text preview in the pane and a "Open in browser" affordance that uses the existing `shell:open` flow. PDFs show extracted text; image kinds show the existing `ImageViewer`. Files of unsupported kinds show "Cannot preview this file type" with a "Show in Folder" button (mirror the existing context-menu action).
- **Snippet XSS guard (carries from Unit 8).** The result rows in the dedicated view use the same `SearchResultRow` component; the constraint applies automatically.

### Phase 5 — UX polish + hardening

- [ ] **Unit 11: First-run + cold-start UX**

  **Goal:** A blocking onboarding modal on the very first launch shows model download progress, Cancel, Retry, and "Skip for now (FTS-only)". Subsequent launches are non-blocking — Cmd+K accepts queries during the ~3-10 s sidecar warmup with a "Search initialising…" hint and FTS-only results.

  **Requirements:** R21, R21+.

  **Dependencies:** Units 4, 8, 10.

  **Files:**
  - Create: `src/features/onboarding/components/SearchOnboardingModal.tsx`
  - Create: `src/features/onboarding/hooks/useFirstRunDetection.ts` (reads a sentinel file via Rust command)
  - Create: `src-tauri/src/commands/onboarding.rs` (`is_first_run`, `mark_onboarding_complete`)
  - Modify: `src-tauri/src/lib.rs` (register onboarding commands)
  - Modify: `src/app/App.tsx` (mount the modal at the app root when `useFirstRunDetection()` resolves true)
  - Modify: `src/features/search/components/SearchPalette.tsx` (cold-start banner when `state="initialising"`)
  - Create: `src/features/onboarding/components/SearchOnboardingModal.test.tsx`
  - Create: `src/features/onboarding/hooks/useFirstRunDetection.test.ts`

  **Approach:**
  - First-run sentinel: a file at `~/.cogios/search/onboarding.complete` written by the Rust `mark_onboarding_complete` command. `is_first_run` returns true if the file does not exist.
  - The onboarding modal is mounted at the app root, on top of all sections, blocking interaction. Closing requires either completion ("All models ready"), explicit cancel, or "Skip for now".
  - Each model has a row with state + progress bar. Cancel is per-model OR all-at-once. Retry is per-model on `state=error`.
  - "Skip for now" writes the sentinel and closes the modal. The app starts in FTS-only mode; `models/status` is checked again on next launch.
  - Cold-start banner in `SearchPalette` consumes the `state` field from `searchQuery` responses; when `state="initialising"` it renders "Search initialising — keyword results only" and re-issues the query when state transitions to `ready` (via a polling hook on `models/status`).

  **Patterns to follow:**
  - `src/features/explorer/components/MountModal.tsx` for the modal shell.
  - `src/features/explorer/components/ExplorerLayout.tsx` for the at-app-root mounting pattern.

  **Test scenarios:**
  - Happy path: fresh install — `is_first_run` returns true; modal opens; download progresses; on completion, modal closes; sentinel is written.
  - Happy path: subsequent launch — `is_first_run` returns false; modal does not appear; cold-start banner shows briefly while the sidecar warms up.
  - Edge: cancel mid-download — the partial file is cleaned up by the ModelManager (Unit 4); the onboarding state shows "Cancelled — Skip or Retry"; clicking Skip writes the sentinel; clicking Retry restarts download.
  - Edge: "Skip for now" with no models downloaded — sentinel is written; the user can search FTS-only forever; settings page surfaces "X models not downloaded" prompt.
  - Edge: network failure mid-download — error state with Retry; user retries, download resumes via Range request (Unit 4).
  - Error: sentinel write fails (disk full) — error toast; modal stays open.
  - Integration: end-to-end fresh-install flow with mocked downloads.

  **Verification:**
  - First launch shows the modal; second launch does not.
  - Cancel and Skip both write the sentinel.
  - Cold-start banner renders correctly when `state="initialising"`.

- [ ] **Unit 12: CSP + cross-platform packaging**

  **Goal:** Define a non-null CSP for the search-rendered surfaces (palette + dedicated view + settings) and lay the ground for cross-platform packaging by documenting the macOS-arm64-only v1 target, the Intel-Mac / Linux-arm64 / Windows gaps, and the PyInstaller smoke-test gate.

  **Requirements:** Security decisions (CSP), Risks (cross-platform).

  **Dependencies:** Unit 8 + 9 + 10 (UI surfaces stable enough that the CSP can be derived from real render needs).

  **Files:**
  - Modify: `src-tauri/tauri.conf.json` (`security.csp` set to a non-null directive set; `bundle.externalBin: ["binaries/search-sidecar", "binaries/llama-server"]`; `bundle.active` flipped to `true` for release packaging, kept `false` only during dev iteration)
  - Create: `sidecar/uv.lock` (uv-managed lockfile with hashes; the `--locked` flag is the supply-chain baseline)
  - Create: `docs/sidecar/packaging.md` (notes on the macOS-arm64 build, the platform gaps, the PyInstaller `--onedir` recipe, the `llama-server` fetch step)
  - Create: `sidecar/packaging/build_macos_arm64.sh` (developer-facing script — produces `dist/search-sidecar-aarch64-apple-darwin/` and copies the `search-sidecar` entry point to `src-tauri/binaries/search-sidecar-aarch64-apple-darwin`)
  - Create: `sidecar/packaging/fetch_llama_server.sh` (developer-facing script — downloads the platform-specific `llama-server` binary from the pinned llama.cpp GitHub release, verifies SHA-256, places it at `src-tauri/binaries/llama-server-aarch64-apple-darwin`)
  - Create: `sidecar/packaging/llama_server_manifest.toml` (pinned llama.cpp release tag + per-platform binary URLs + SHA-256 hashes; the supply-chain manifest for the captioner runtime)
  - Create: `.github/workflows/build-sidecar.yml` (CI that runs both build scripts on push to main)
  - Modify: `package.json` (add `npm run build:sidecar` and `npm run fetch:llama-server` scripts)
  - Create: `src-tauri/tests/csp_smoke.rs` (boots a webview with the configured CSP and asserts the search surfaces render without violations — this may require a manual checklist instead of an automated test if Tauri's test harness can't validate CSP; flag in deferred questions)

  **Approach:**
  - **CSP starting point:**
    ```
    default-src 'self';
    img-src 'self' asset: tauri:;
    style-src 'self' 'unsafe-inline';   # CodeMirror needs inline styles
    script-src 'self';
    connect-src 'self' http://127.0.0.1:*;
    font-src 'self';
    object-src 'none';
    frame-ancestors 'none';
    ```
    `connect-src` allows the Rust → sidecar HTTP traffic. Tighten `style-src` if CodeMirror can be configured without inline styles.
  - **PyInstaller recipe.** `--onedir` with `--collect-all numpy lancedb pyarrow transformers tokenizers optimum paddleocr` and `--collect-binaries onnxruntime pymupdf` (the `--collect-all numpy` line is mandatory per spike v1 finding F-3 — without it, numpy 2.x crashes at runtime with `ModuleNotFoundError: numpy._core._exceptions`). **No `--collect-binaries llama_cpp`** — the captioner is a separate `llama-server` binary, not a Python wheel (see Architecture). Sign all dylibs in `dist/<name>/_internal/` with `codesign --deep --options runtime`. **Inputs to PyInstaller come exclusively from `uv.lock`** (installed via `uv sync --locked`) — never from a freeform install. This is the supply-chain baseline; without it, a compromised PyPI mirror can inject code into the signed Cognios binary.
  - **`llama-server` packaging.** `fetch_llama_server.sh` downloads the host-tuple binary from the pinned llama.cpp GitHub release (e.g., `https://github.com/ggml-org/llama.cpp/releases/download/<tag>/llama-bin-macos-arm64.zip`), unzips, verifies SHA-256 against `llama_server_manifest.toml`, and places `llama-server` at `src-tauri/binaries/llama-server-<host-tuple>` ready for `bundle.externalBin`. The Metal shader file `ggml-metal.metal` is included in the official archive — no manual collection needed (this is the cross-platform-distribution win that drove the switch from `llama-cpp-python`). Codesigning the binary uses the same Developer ID as the rest of the bundle.
  - **Tighten `--storage-dir` validator regex.** The capability scope from Unit 2 currently uses `{"validator": ".+"}` which matches any non-empty string including path-traversal sequences. Tighten to `{"validator": "^/[^\\x00]+$"}` to require an absolute POSIX path with no null bytes; additionally, the sidecar's startup code asserts that `os.path.realpath(storage_dir)` resolves under the user's home directory before creating any files.
  - **Documentation.** `docs/sidecar/packaging.md` captures the platform support matrix, the build script invocation, and the troubleshooting notes for known pitfalls (onnxruntime CoreML EP, lancedb liblzma, notarization). This is the artifact a future contributor needs when extending support to a new platform.
  - **CI.** A separate workflow that installs Python, runs `build:sidecar`, and stashes the artifact for the next `tauri build` step. macOS arm64 is the only matrix entry for v1.
  - **Smoke test.** A Vitest test that loads `tauri.conf.json` and asserts the CSP includes the required directives. The functional CSP test (rendering the search palette without violations) is manual at v1; flag for v1b.

  **Patterns to follow:**
  - This is a new component; future operational scripts under `sidecar/packaging/` follow this layout.

  **Test scenarios:**
  - Happy path: CSP is non-null; `connect-src` allows 127.0.0.1.
  - Happy path: `npm run build:sidecar` produces a binary at the expected path on macOS arm64 in CI.
  - Edge: a forbidden source (e.g. `connect-src` to a non-loopback URL) is rejected at runtime — manual verification at v1.
  - Error: PyInstaller build fails (missing hidden import) — CI surfaces the error; Unit 12 contains a documented fix list.

  **Verification:**
  - CSP is set; the search surfaces render on a fresh dev build.
  - The CI workflow produces a sidecar binary on a clean macOS arm64 runner.
  - Documentation in `docs/sidecar/packaging.md` is sufficient for a contributor to reproduce the build.

## System-Wide Impact

- **Interaction graph:** **two** new child processes run alongside the Tauri app for the entire app lifetime — `search-sidecar` (Python; FastAPI on its own loopback port) and `llama-server` (C++; OpenAI-compatible HTTP on a separate loopback port). Every node mutation flows through Rust → HTTP `POST /events/node` → Python queue. Every search request flows React → Rust IPC → HTTP → Python → lancedb → response chain. Caption requests flow Python → HTTP → `llama-server` → response back to Python (Rust does not see caption traffic). The Cmd+K palette replaces an existing stub in `AppSidebar.tsx` — the existing keyboard-shortcut wiring is preserved.
- **Error propagation:** failures in the sidecar manifest as typed `{state}` envelopes on the Rust side, never as panics. The UI handles `unavailable | initialising | models_missing | degraded` distinctly. Network-level errors against the sidecar are caught by the Rust HTTP client and converted to typed envelopes.
- **State lifecycle risks:**
  - Stale-`node_id` returned by search after delete — Unit 7 forwards the deletion event; until the sidecar processes it, search may name a deleted node. Agents and the UI must treat "not found" from `get_*_content` as a normal outcome (per origin doc).
  - Half-built lancedb table on model swap mid-rebuild — the rebuild keeps the old table until the new one is verified; on crash, the half-built table is detected at startup and resumed.
  - Orphaned PyInstaller process from a prior crashed app — the sidecar checks for and overwrites a stale `sidecar.runtime` file on startup.
  - Unsaved note's flush + concurrent indexing — the sidecar receives the `node-saved` event after Rust persists; no race, since the event fires after persistence (Unit 1).
- **API surface parity:** the same `searchQuery` IPC powers the palette, the dedicated view, and any future agent tool wrapper. There is no second search API. Filter parsing happens once, in the sidecar.
- **Integration coverage:** Phase 1 prerequisites (VFS emit gaps in Unit 1) require integration tests, not just unit tests, because the failure mode is "search index drifts from `cognios.db` after a mutation" — only an integration test that runs both DBs proves the chain works.
- **Unchanged invariants:**
  - `cognios.db` schema is **not** modified. No new columns. No new tables.
  - The existing `vfs://changed` event payload shape is unchanged.
  - The existing `tauri-plugin-shell` `shell:allow-open` capability is unchanged (the new `shell:allow-execute`/`shell:allow-spawn` entries are additive).
  - The existing four sidebar sections (`home / chat / explorer / memory`) are unchanged; Settings is added as a fifth.
  - Existing IPC commands (`get_note_content`, `read_file_content`, etc.) are unchanged. Agents call them after `search`.
  - The existing Cmd+K stub is replaced — this is a deliberate change and not an invariant violation.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| **PyInstaller bundle on macOS arm64 fails for one of the deep ML deps** (lancedb and paddleocr-onnx are the remaining offenders; `llama-cpp-python` is no longer in scope — see Architecture) | Spike v1 (sidecar/spike/) already validated lancedb. Spike v2 will validate paddleocr-onnx + transformers. If any dep still cannot be bundled, fallback options: (a) ship as separate dylibs and reference at runtime, (b) drop the dep — paddleocr can be replaced by a different OCR engine via the provider abstraction. |
| **`llama-server` upstream API change breaks the captioner integration** | Pin to a specific llama.cpp release tag in `sidecar/packaging/llama_server_manifest.toml`. Verify SHA-256 of the binary at fetch time. The OpenAI-compatible chat-completions endpoint is the most stable surface llama.cpp offers; multimodal support (`--mmproj`) is also stable. Re-pin only when a deliberate upgrade is reviewed. |
| **Gemma 3n GGUF inference is too slow on CPU for the indexing-throughput target** | Captioning is the slowest pipeline; if throughput is unacceptable, surface a "captioning disabled" toggle in Settings (still indexes OCR) and revisit in v1b. The 30-second / 1000-file success criterion already excludes captioning latency from the target. |
| **lancedb's hybrid search has a known filter-clause bug** ([#1656](https://github.com/lancedb/lancedb/issues/1656)) | Verify on the chosen lancedb version (Unit 6). Workaround: use `prefilter=False` (post-filter) when both FTS and a scalar index are present on the table. |
| **Sidecar HTTP unauthenticated traffic from co-resident processes** | Closed in Unit 2: bearer token + 127.0.0.1 binding. Verify in Unit 3's auth tests. |
| **API keys leaked via plaintext config or logs** | Unit 10 routes secrets through Tauri secure storage; FastAPI request logger redacts `Authorization`. |
| **Stale `node_id` returned by search races with `get_*_content` callers** | Documented contract: agents handle "not found" gracefully (origin doc). UI does the same — clicking a result that no longer exists shows a transient toast and refreshes. |
| **Cold-start blocks the user on every launch** | Unit 11's cold-start hint accepts queries during warmup; FTS-only fallback (Unit 6) returns useful results immediately. |
| **First-run download is large (~4.3 GB) and may fail mid-stream** | Unit 4's Range-resume; Unit 11's Cancel + Retry + Skip. |
| **Intel Mac users / Linux users / Windows users install the app** | Unit 12 documents the platform target. The installer (Unit 12) only runs on macOS arm64 in v1. The Cargo workspace and TS code are platform-agnostic; the gap is the sidecar binary. |
| **Corrupt PDF crashes PyMuPDF and takes down the sidecar** | Unit 5's per-job try/except wrapper catches exceptions; per-job timeout fires for hangs. The sidecar's restart supervisor (Unit 2) handles the unrecoverable case. |
| **Embedding model's output dimension changes between two minor model versions** | The commit hash in the manifest (Unit 4) pins the exact version. Switching to a different commit triggers re-index (Unit 6's table-rebuild flow). |
| **The plan assumes a single user; multi-user / shared-host scenarios may surface auth gaps** | Out of scope for v1. The bearer token + 0600 file mode is sufficient for the single-user case. |

## Documentation / Operational Notes

- `docs/sidecar/packaging.md` (created in Unit 12) is the operational runbook for the sidecar build.
- The Settings page (Unit 10) is the user-facing control surface; in-app links to the Gemma license and any provider-specific terms must be live URLs.
- No new monitoring infrastructure (the app is desktop-only, no telemetry pipeline).
- Sidecar logs live at `~/.cogios/search/sidecar.log` — rotate manually for v1, structured rotation deferred to v1b.

## Phased Delivery

### Phase 1 — Sidecar foundations (Units 1-3)

The first slice that gets a Python sidecar process running, supervised, and authenticated. Search isn't usable yet, but the app boots and shuts down cleanly with the sidecar in place. This phase de-risks the Tauri-Python integration first because it has the most unknowns.

### Phase 2 — Indexing (Units 4-6)

Models download, content gets indexed, and lancedb stores the data. This phase delivers the first signal that the architecture is sound: a `POST /events/node` event for a real note shows up in the queue, gets processed, and is searchable via direct lancedb query (even before the IPC layer is wired).

### Phase 3 — Retrieval API (Unit 7)

The IPC contract that connects the React UI to the sidecar. After this phase, a developer can `searchQuery` from the Rust side and get real results.

### Phase 4 — UI surfaces (Units 8-10)

The user-facing payoff: Cmd+K, dedicated view, Settings. This is also the first phase that surfaces the degraded / initialising / unavailable states to the user.

### Phase 5 — UX polish + hardening (Units 11-12)

First-run flow, cold-start UX, CSP, packaging. This phase is what makes v1 shippable rather than just demoable.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-26-search-requirements.md](../brainstorms/2026-04-26-search-requirements.md)
- **Existing patterns:**
  - `src-tauri/src/services/url_indexing/queue.rs` — background queue precedent
  - `src-tauri/src/services/mounts/watcher.rs` — VFS event payload shape
  - `src-tauri/src/lib.rs` — `app_handle.emit("vfs://changed", event)` canonical sink
  - `src-tauri/src/commands/notes.rs`, `commands/urls.rs`, `commands/mounts.rs` — IPC command + DTO conventions
  - `src/lib/tauri/ipc.ts`, `src/features/explorer/api/explorerClient.ts` — TS client pattern
  - `src/features/explorer/components/MountModal.tsx` — modal shell
  - `src/app/AppSidebar.tsx:67-92` — existing Cmd+K stub being replaced
- **Tauri sidecar docs:** [v2.tauri.app/develop/sidecar](https://v2.tauri.app/develop/sidecar/), [v2.tauri.app/reference/config](https://v2.tauri.app/reference/config/), [tauri-plugin-shell crate](https://crates.io/crates/tauri-plugin-shell)
- **lancedb:** [lancedb.github.io/lancedb/python/python](https://lancedb.github.io/lancedb/python/python/), [docs.lancedb.com/search/full-text-search](https://docs.lancedb.com/search/full-text-search)
- **Gemma 3n:** [huggingface.co/google/gemma-3n-E2B-it](https://huggingface.co/google/gemma-3n-E2B-it), [huggingface.co/unsloth/gemma-3n-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF)
- **GTE multilingual ONNX:** [huggingface.co/onnx-community/gte-multilingual-base](https://huggingface.co/onnx-community/gte-multilingual-base), [huggingface.co/onnx-community/gte-multilingual-reranker-base](https://huggingface.co/onnx-community/gte-multilingual-reranker-base)
- **PaddleOCR ONNX:** [github.com/PaddlePaddle/PaddleOCR/discussions/14572](https://github.com/PaddlePaddle/PaddleOCR/discussions/14572), [pypi.org/project/paddleocr-onnx](https://pypi.org/project/paddleocr-onnx/)
- **PyInstaller:** [pyinstaller.org/en/stable/usage.html](https://pyinstaller.org/en/stable/usage.html)
