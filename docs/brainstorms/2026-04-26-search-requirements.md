---
date: 2026-04-26
topic: search
---

# Cross-Workspace Search

## Problem Frame

Cognios stores user content across multiple node kinds — folders, mounts, mounted files, URLs, notes — but currently provides no way to search across them. As the workspace grows past tree-navigable size (a few hundred nodes), users can't find specific notes, locate a forgotten URL, or pull together everything related to a topic. Without search the app's discoverability ceiling is "what fits in the tree sidebar at a glance".

The user explicitly wants a search that:
- Finds **specific known nodes** ("that note about OAuth from last week")
- Aggregates **across sources** (notes + URL contents + mounted files + image content), ranked by relevance
- Supports **grep-like precision** with metadata filters (kind, time range, mount)
- Is **agent-callable** — the same search can be exposed to LLMs as a tool, returning stable `node_id`s the agent then resolves to full content

This is search, not RAG question-answering. LLM integration is a follow-up: the agent calls `search(query)` to get node IDs, then calls existing per-kind read commands (`get_note_content`, `read_file_content`) to fetch full content for synthesis. Cognios does not generate answers itself.

**Target user.** v1 is built for a Chinese-primary user (the model defaults — gte-multilingual + PP-OCR + Gemma — are chosen accordingly). Non-Chinese-primary users are a v2 concern; "multilingual" framing in this doc reflects the bundled models, not a generalised target audience.

## Priority Tiers

The 23 requirements below are tagged P0/P1/P2 so scope can be cut under schedule pressure without rejecting the entire document.

- **P0** — must ship for v1 to be useful. If a P0 requirement is cut, the success criteria do not hold.
- **P1** — ships in v1 by intent of the user; provides core UX completeness, not core retrieval.
- **P2** — explicitly out of scope for v1 (see Scope Boundaries) but listed here to preserve design intent.

## Requirements

### Search API (P0)

- **R1.** A single `search(query, filters?)` IPC command returns a ranked list of nodes matching the query across all indexed content types. The same API powers both the UI and any future agent-tool wrapper.
- **R2.** Each result row carries: stable `node_id`, `kind`, `name`, `score`, `snippet` (~150 chars with matched terms highlighted as plain-text offsets — no HTML in the payload), `matched_in` (one of `name` | `content` | `both`), and breadcrumb `path` for context.
- **R3.** Results are aggregated per-node — even if a long PDF or note has 5 chunk-level matches, the result is one row using the highest-scoring chunk's snippet. The agent calls existing per-kind read commands (`get_note_content`, `read_file_content`, etc.) to fetch full content; there is no new unified `get_node_content` dispatcher.
- **R4.** Hybrid retrieval is the default: keyword (FTS) signal + semantic (embedding) signal + cross-encoder rerank. Query shape implicitly weights the components — short queries lean keyword, long descriptive queries lean semantic. Users do not pick a mode. **Fallback:** when the embedding model is unavailable (downloading, missing, sidecar warming up) the search degrades to FTS-only with a banner; the API contract is identical and the UI labels the degraded state. See Reliability Decisions.

### Filters via query syntax

- **R5 (P0).** `kind:` and `mount:` filters are expressed inline as query operators in the Cmd+K palette:
  - `kind:note` / `kind:file` / `kind:url` (single or comma-separated)
  - `mount:<mount-name>` (limit to nodes inside a specific mount)
- **R5+ (P1).** Date operators ship with the dedicated search view's filter UI, and as inline syntax once the parser stabilises:
  - `created:>2026-01-01` / `created:<2026-04-01` / `created:7d` (relative)
  - `modified:` analogous
- **R6 (P0).** Invalid syntax falls through as plain query text (no error), so users never get a "syntax error" wall.

### Indexed content sources (P0)

- **R7.** The following content is indexed for full-text and vector search. Each branch is one explicit pipeline:
  - **Notes** — body of `~/.cogios/notes/*.md` (text path)
  - **Mounted text files** — `.md` / `.mdx` / `.txt` (text path)
  - **URL fetched content** — the existing Rust URL pipeline (`src-tauri/src/services/url_indexing/pipelines/default_web.rs`) already fetches and strips HTML to `preview_text`. The sidecar reads the cached extracted text — it does not re-fetch or re-strip. No `trafilatura` dependency.
  - **PDFs** — text-based extraction via PyMuPDF; per-page OCR fallback when text extraction yields nothing for a page (scanned pages)
  - **Images** — `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.bmp`. Each image runs through **two parallel processors**: OCR (PP-OCRv4) for any literal text, and image captioning (Gemma-3-E2B-IT) for a one-paragraph natural-language description. Both outputs are indexed, so a query like "diagram of OAuth flow" can hit a captioned diagram even when no embedded text exists.
- **R8.** All node names and metadata (kind, created/modified) are also indexed for the keyword path, so even if a file is in an unsupported format its name is searchable.

### Per-mount pipeline tagging — extensibility hook (P1)

- **R9.** Each mount carries a `kind` tag (default `general`). v1 only ships `general`. The tag is the dispatch hook for future per-mount pipelines (e.g. a `code` mount kind would parse AST instead of doing OCR on `.png` source maps). Out of scope for v1: actually shipping non-`general` kinds. Scope-guardian flagged this as speculative; it is kept as P1 because the user explicitly wanted the extension point reserved.

### Indexing pipeline (P0)

- **R10.** Indexing runs in a background queue inside the Python sidecar. Writes (create/edit/delete a node, mount a directory) trigger an event from Rust to the sidecar; the sidecar enqueues and processes asynchronously. Save / mount / delete IPC calls return immediately — they never block on indexing.
- **R11 (P1).** Per-node indexing status is exposed via a sidecar HTTP query (`GET /index/status`) that returns queue depth, in-flight nodes, and per-node `(state, indexed_at)`. Rust does **not** persist indexing state in `cognios.db`; the sidecar owns that state in `~/.cogios/search/queue.db`. The UI surfaces a global queue depth + count in a sidebar footer, and the Inspector shows per-node `indexed_at` for a selected node by querying the sidecar lazily. This avoids the two-writer problem flagged in review.
- **R12.** On node deletion or mount removal, the sidecar removes the corresponding entries from FTS and vector indices.
- **R13.** The pipeline dispatches per-content-type (using the per-mount `kind` tag from R9 as a future override hook):
  - text/markdown → read directly
  - PDF → PyMuPDF text extraction; per-page OCR fallback for pages with no text
  - image → OCR (PP-OCRv4) and caption (Gemma-3-E2B-IT) in parallel; both outputs feed the index
  - URL → read pre-stripped `preview_text` from the existing Rust URL pipeline cache
- **R13+.** Each pipeline job has a per-node timeout (default 60s for text/PDF, 300s for OCR+caption) and a sidecar-process memory cap. On timeout, OOM, or unhandled exception, the node is marked `error` and the queue continues. PDF parsing runs inside a try/except; the sidecar does not crash on a malformed PDF.

### UI surfaces

- **R14 (P0).** **Cmd+K palette** is the primary search entry. Global keyboard shortcut opens a floating overlay with a single search input and a flat result list. Type-as-you-search (debounced ~150ms). Each row shows `kind` icon + node name + one-line snippet + breadcrumb path. ↑/↓ navigates, Enter activates the selected node (same activation flow as tree single-click), Esc closes. Filters use the inline syntax from R5.
- **R15 (P1).** **Dedicated search view** (Cmd+Shift+F or "More results" link from Cmd+K) opens as a center-pane surface — same place note editor / markdown preview render. Has a search input, full filter UI (kind multi-select, date pickers, mount picker), longer scrollable result list, and a preview pane showing the selected result. Does not block the tree — the tree stays interactive on the left.
- **R16 (P0).** Both surfaces consume the same `search` API; the dedicated view just renders more results and exposes filters as UI affordances rather than query syntax.

### Pluggable provider abstractions (P1)

- **R17.** Each ML role (embedding / reranker / OCR / PDF extractor / image_captioner) has a provider abstraction. Default providers run locally inside the Python sidecar. Users can configure remote providers (HTTP, OpenAI-compatible API) per role through settings. A user could, for example, run embedding locally with the bundled model but use a cloud reranker.
- **R18.** Provider configuration is per-role: each role has `{ type: "local" | "http", model_id?, base_url?, api_key?, model_name? }`. Switching providers triggers re-indexing only when the embedding dimension changes. Re-indexing is a confirmed, resumable operation — see Reliability Decisions.
- **R18+.** When a user configures any HTTP provider, the Settings UI shows an explicit privacy disclosure: "Configuring a remote provider will send the full text of indexed content to <base_url>. Continue?" The disclosure is shown again whenever `base_url` changes.

### Model management (P1)

- **R19.** Models are not bundled into the app installer. They are downloaded on first launch / when the user changes the configured model.
- **R20.** A `ModelManager` inside the Python sidecar handles download, integrity verification, on-disk catalog, and serving status to the UI. The UI exposes:
  - A Settings page listing each role and the configured model (see UX Decisions for the entry point in app navigation)
  - Download progress per model (streamed via SSE)
  - Model status (`missing` / `downloading` / `verifying` / `ready` / `error`)
  - "Switch model" action that triggers download + (if needed) confirmed re-index
- **R21.** First-run UX: app starts; sidecar boots and begins downloading models; UI shows a blocking onboarding screen with per-model progress, an explicit Cancel button (cancels download, leaves user in FTS-only mode), and a Retry button on network failure. Once any individual model is ready it can be used; the user does not have to wait for all models. FTS-only search is available the moment the FTS index is built (no model dependency).
- **R21+.** Cold-start on every subsequent launch: the sidecar re-loads the ONNX sessions from disk (~3–10s on a typical Mac SSD). During this window `search` returns `{state: "initialising", retry_after_ms: 500}` and the UI shows a non-blocking "Search initialising…" hint in the palette. FTS-only results stream during this window; semantic results merge in once the embedding session is loaded.

### Default models (v1 baseline; user-replaceable per R17/R19)

| Role | Model | On-disk size (approx.) |
|------|-------|------------------------|
| Embedding | `Alibaba-NLP/gte-multilingual-base` (305M, 768-dim, multilingual incl. Chinese) | ~620 MB ONNX |
| Reranker | `Alibaba-NLP/gte-multilingual-reranker-base` (cross-encoder) | ~560 MB ONNX |
| OCR | `PaddlePaddle/PP-OCRv4_mobile` (lightweight, multilingual) | ~50 MB |
| Image captioner | `google/gemma-3-e2b-it` (2B-param multimodal VLM, image→text) | ~5 GB |

**First-run download total: ~6.2 GB.** This is significantly larger than the original "~1GB" estimate — the Gemma captioner is the dominant cost. The first-run UX (R21) must reflect this.

### Data ownership and storage layout (P0)

- **R22.** The Python sidecar owns its own storage at `~/.cogios/search/` containing:
  - FTS database (SQLite FTS5)
  - vector store (lancedb embedded)
  - indexing queue state (`queue.db`, also SQLite)
  - downloaded models (`~/.cogios/search/models/<role>/<commit-hash>/`)
  - sidecar log file
  
  This directory is fully separate from `cognios.db` (which Rust owns). User backup of `~/.cogios/` captures both.

### Crash safety and durability (P0)

- **R23.** Sidecar restart resumes the indexing queue from `queue.db`. Partial-index errors mark the node `error` (in the sidecar's queue table, not in `cognios.db`) and continue. The search index is durable across app restarts. A sidecar crash mid-query surfaces as a typed `{state: "unavailable", retry_after_ms: 1000}` response on the Rust HTTP client; Rust restarts the sidecar and retries up to a small bounded number of times before surfacing the error to the UI.

## Architecture: Sidecar Boundaries

This section makes architectural decisions explicit so the planner does not have to reverse-engineer them from prose.

**Tauri sidecar wiring (new work; not yet in place).** The codebase currently registers `tauri-plugin-shell` for URL opening only (`shell:allow-open` capability). Spawning the Python sidecar requires three additional pieces that the original brainstorm wrongly described as "already added":
1. `bundle.externalBin: ["binaries/search-sidecar"]` in `src-tauri/tauri.conf.json`.
2. A capability scope entry in `src-tauri/capabilities/default.json` of the form `{"identifier": "shell:allow-execute", "allow": [{"name": "binaries/search-sidecar", "sidecar": true, "args": [...]}]}`. **Do not** grant a wildcard `shell:allow-execute`.
3. `src-tauri/binaries/` populated at build time with the platform-suffixed PyInstaller output (e.g. `search-sidecar-aarch64-apple-darwin`). `bundle.active` must be `true` for release builds.

**Transport.** HTTP over `127.0.0.1` (loopback only — never `0.0.0.0`). Port allocation: dynamic; the sidecar selects a free port at startup, writes it to a runtime file readable only by the user (`~/.cogios/search/sidecar.runtime`), and Rust reads that file before issuing any request.

**Authentication.** A cryptographically random 256-bit token is generated at sidecar startup and written to the same `sidecar.runtime` file (alongside the port). Every HTTP request from Rust includes `Authorization: Bearer <token>`. The sidecar rejects any request without the matching token. This closes the SSRF gap that an unauthenticated localhost service would otherwise create.

**Path-traversal responsibility.** Rust canonicalises every path before sending it to the sidecar (mirror of the existing pattern in `src-tauri/src/services/files/read_file_content.rs` and `src-tauri/src/commands/thumbnails.rs`). The sidecar accepts only absolute paths supplied in IPC events from Rust; it does **not** open any path derived from user input or from its own indexing queue resolution. Paths in `queue.db` are write-once at enqueue time.

**Storage-dir handoff.** The sidecar receives the workspace root (`~/.cogios/`) as a CLI argument at spawn (`search-sidecar --storage-dir <path>`). The `nodes` table does not store note paths; Rust resolves note absolute paths at event-emit time as `<storage-dir>/notes/<id>.md`.

**IPC event payload.** Rust → sidecar event for any node mutation includes the resolved absolute content path:
```
{ event: "node_changed" | "node_deleted",
  node_id, kind, name, absolute_content_path?, mount_id?, created_at, updated_at }
```
The sidecar does not read `cognios.db` directly. This makes the two databases independent.

**Stale-result contract.** Search results may name a `node_id` that has been deleted between the search call and a subsequent `get_*_content` call. Agents and the UI must treat "node not found" from the read commands as a normal outcome, not an error to surface. The search API does not guarantee live IDs — only that the snapshot at result-emit time was consistent.

## Security Decisions

- **Sidecar HTTP authentication** — bearer token over loopback, as above. Closes SEC-001.
- **Path-traversal responsibility** — Rust validates; sidecar trusts only Rust-supplied absolute paths. Closes SEC-002.
- **Model integrity** — every default model is pinned to a specific HuggingFace commit hash (recorded in the sidecar source). Each downloaded file is SHA-256-verified against a manifest shipped in the app binary before the model is loaded into memory. A mismatch deletes the file and surfaces an error in the ModelManager UI. Closes SEC-003.
- **API key storage** — provider `api_key` values are stored in the OS keychain via the Tauri secure-storage plugin. They are never written to a config file or to the sidecar's launch environment. Rust retrieves the key at call time and forwards it on the outbound request to the configured `base_url`. The sidecar's request logger redacts `Authorization` headers. Closes SEC-004.
- **HTTP provider privacy disclosure** — see R18+. Closes SEC-005.
- **Tauri ACL scope** — `shell:allow-execute` is scoped to the sidecar binary identifier only. No wildcard execute. Closes SEC-006.
- **OCR/caption snippet sanitisation** — OCR and caption outputs are stored verbatim in the FTS index. The result `snippet` field is plain text; the frontend renders snippets with text rendering only (never `innerHTML`). Match highlighting is applied as offset metadata, not as embedded HTML. Closes SEC-007.
- **PDF parsing isolation** — pin PyMuPDF to a current release with checked CVE history; wrap every PDF parse in a try/except that converts any exception into a per-node `error` state without crashing the sidecar. Memory caps are enforced at the OS level (e.g. `RLIMIT_AS`) where supported. Closes SEC-008.
- **CSP** — the search UI introduces the first surfaces that render third-party-derived text (URL bodies, PDF text, OCR, captions) directly into result rows. `tauri.conf.json` currently has `csp: null`. Defining a non-null CSP is a prerequisite to shipping the search UI; the plan must include this work. Closes SEC-009.

## Reliability Decisions

- **Sidecar lifecycle.** Spawned at app launch via `tauri-plugin-shell`'s sidecar API. Tauri supervises the process; on crash the supervisor restarts it (with exponential backoff up to 3 attempts before surfacing "search unavailable"). Health check: `GET /healthz` returns `{state: "ready" | "initialising" | "models_missing"}` plus the per-role model state.
- **Cold-start on every launch.** `R21+` is part of the contract, not a first-run-only concern. The palette accepts queries during cold-start and returns FTS-only results plus a "Search initialising…" hint.
- **FTS-only fallback.** When `embedding.state != "ready"`, the search pipeline runs FTS-only and returns results with a `degraded: true` flag. The UI shows a banner: "Semantic search initialising — showing keyword matches." No requirement is silently dropped.
- **Search during fresh-mount indexing.** A search at `t=10s` after mounting a 1000-file directory returns whatever has been indexed so far, plus a `partial: {indexed: N, total: M}` field on the response. The UI surfaces this honestly ("Searching X of Y indexed nodes") rather than letting the result list silently grow.
- **Re-index after model swap.** Triggered only when the embedding dimension changes. Flow: (1) confirmation dialog shows node count, ETA, and "search will be FTS-only during reindex"; (2) on confirm, a fresh lancedb table is created and the queue rebuilds against it; (3) the old table is dropped only after the rebuild completes; (4) crash recovery: on next sidecar start, a half-built table is detected and the queue resumes from disk state. Search remains FTS-only throughout.
- **Pipeline timeouts and memory caps** — see R13+.
- **Stale-ID contract** — see Architecture.
- **Partial model download** — the ModelManager uses HTTP Range requests to resume; a partial file is detected by missing SHA-256 and re-downloaded. A truncated file is never loaded into ONNX Runtime.

## UX Decisions Resolved

These resolve the design-lens findings to the level needed for planning. Visual design and final ARIA roles can still iterate during implementation, but the load-bearing decisions are fixed here.

**Cmd+K palette behaviour**
- Result count cap: top **15** results visible; "More results in dedicated view (⇧⌘F)" link as the 16th row when there are more matches.
- Pre-query empty state: top 10 most-recently-modified nodes (any kind) act as a quick-jump list. Matches the "find a known node" use case better than a blank pane and avoids the search-history scope rule.
- Keystrokes while a result row is selected with ↑/↓ return focus to the input and append the character to the query (the result list re-filters on the new query).
- Modifier keys: none in v1. Plain Enter activates the selected node. (Cmd+Enter / Shift+Enter behaviours are deferred to v2.)
- Esc closes the palette and returns focus to the previously-focused element in the tree.

**Result row layout**
- Layout: `[kind icon] [bold name] [muted snippet]` on the first line, `[breadcrumb]` on a smaller second line.
- Breadcrumb truncation: middle-truncate with ellipsis (`Workspace / … / Nested / file.md`) when over ~60 chars, preserving the leading mount and trailing leaf.
- Score is **not** shown to the user.
- Modified time is shown only in the dedicated view (as a column), not in the Cmd+K palette.

**Query syntax discoverability**
- A small `?` icon lives at the right edge of the Cmd+K input. Clicking it opens an inline popover listing the supported operators and one example each. No autocomplete (consistent with scope rules).

**Dedicated search view layout**
- Filter UI: kind multi-select chips, date pickers (created / modified), mount picker.
- Sort: relevance (default), modified date (descending). No grouping by kind in v1 — flat list.
- Result count: top 50 with cursor-based pagination ("Load more"). The latency target does not apply to pagination calls beyond the first page.

**Indexing status surface**
- Sidebar footer: a compact strip showing global queue depth and a count when non-zero ("Indexing 42 of 1000…"). Hidden when the queue is empty.
- Inspector: when a node is selected, its `(indexing_state, indexed_at)` is shown in the metadata block, queried lazily from the sidecar.

**Models-not-ready / cold-start UX**
- First-run: blocking onboarding screen with per-model progress, Cancel and Retry buttons, and a "Skip for now (FTS-only)" option that completes onboarding and starts the app in degraded mode.
- Subsequent launches: non-blocking. Cmd+K is always available; FTS results stream immediately; a banner declares any degradation.

**Settings UI location**
- A new top-level **Settings** section is added to `AppSidebar` alongside `home / chat / explorer / memory`. The Settings page contains the per-role model configuration, the provider abstraction (R17/R18), the privacy disclosure (R18+), and ModelManager status. No keyboard shortcut in v1.

**Model swap confirmation**
- Confirm dialog: "Switching to <new-model> will re-index <N> nodes. Estimated time: ~<M> minutes. Search will use keyword-only matching during reindex. [Cancel] [Switch and re-index]."
- "Cancel" mid-reindex restores the previous model assignment; the half-built table is dropped on next sidecar start.

**Accessibility**
- The Cmd+K palette is implemented as an ARIA combobox with the result list as its `listbox` and rows as `option`. Live region announcement on result-list change ("X results"). Focus trap inside the overlay; focus returns to the prior element on close.
- The dedicated search view's filter pickers are keyboard-navigable (chip multi-selects, native date inputs).
- Touch / mobile is out of scope for v1.

## Success Criteria

- A user with ~500 notes + 2-3 mounted directories (containing PDFs, images, .md files) can find any specific known node by typing 2-3 keywords in Cmd+K and seeing it in the top 5 results within a beat (target: **<300ms after typing stops, with the local default reranker on top-15 candidates, int8 ONNX**). The 300ms target does **not** apply when an HTTP-provider reranker is configured.
- Searching a Chinese keyword finds Chinese content in PDFs, OCR'd images, and image captions alongside notes.
- A long descriptive query like "ideas about authentication patterns" returns semantically related content from across notes / URLs / files / image captions, even when those nodes don't contain the literal words "authentication" or "patterns".
- A query for "diagram of OAuth flow" hits an image of an OAuth flow diagram via its caption, even when the image contains no embedded text.
- After mounting a fresh directory of 1000 mixed files, the user can search node names immediately (instant FTS on names) and search content within ~30 seconds for text/PDF; OCR + caption may take longer and the UI surfaces partial-index state honestly.
- An LLM agent calling `search` receives a stable, well-typed result schema. Stale `node_id`s (deleted between calls) surface as a normal "not found" outcome on the read commands, not as an error.
- The app is usable (FTS-only) on first launch even before any ML model has finished downloading.

## Scope Boundaries

**Out of scope for v1**
- **Code-aware indexing.** No AST parsing, no symbol search, no language-specific tokenization. Mount kind `code` is a future extension hook only — v1 only ships `general`.
- **Question-answering / RAG synthesis.** Cognios does not generate answers. LLM integration is a separate concern: the search API is agent-callable as a tool, but Cognios doesn't run the LLM.
- **High-end document parsing.** No `marker` / `surya` / layout-aware extraction. Text-based PDFs and OCR for scanned pages is sufficient.
- **Search history / saved searches / smart folders.** No persistent search state.
- **In-result feedback / learning from clicks.** No thumbs up/down, no click-through rerank training.
- **Backlinks / cross-references.** Notes / URLs don't get a graph layer.
- **Search-within-current-document.** The note editor's own find-in-document is unchanged; this plan is workspace-wide search.
- **Auto-suggest / query completion.** No fuzzy autocomplete in the input. Plain typing only.
- **Search across `cognios.db` admin / metadata tables.** Only user-visible content is indexed.
- **Cmd+Enter / Shift+Enter modifier behaviours** — v2.
- **Touch / mobile UI** — v2.

**Explicit non-goals on the architecture**
- We are not adopting RAG-Anything or any all-in-one RAG framework. The Python sidecar is a thin assembly of focused libraries (PyMuPDF, sentence-transformers / fastembed, lancedb, paddleocr, Gemma via transformers) under our own FastAPI app. Each library is single-purpose and replaceable. Realistic line count is several thousand lines plus tests; not "~1k lines".
- We are not bundling models in the installer (R19). First-run download is the contract.
- We are not adding an `indexing_state` column to `cognios.db`. Indexing state lives in the sidecar's `queue.db` and is queried via HTTP (R11). This avoids the two-writer problem.

## Key Decisions

- **Search vs. question-answering: pure search.** LLM-as-tool is the integration path; Cognios doesn't host generation. (Sequencing of Q&A relative to search is deferred — see Outstanding Questions.)
- **Hybrid retrieval is default-on with FTS-only fallback** when the embedding model is unavailable. The original "always-on, no fallback" framing was incoherent against R21 and is corrected here.
- **Result granularity is per-node, not per-chunk.** Chunks exist internally but are aggregated for the user-facing list.
- **Python sidecar owns the entire search service**, not just ML transforms. Rust forwards events; Python owns FTS, vector, queue, models.
- **Sidecar transport: HTTP loopback via FastAPI**, with bearer-token auth on every request.
- **Indexing is background-queued.** Saves and mounts never block. Per-job timeouts and memory caps are mandatory.
- **FTS database is separated from `cognios.db`.** Index lives under `~/.cogios/search/` and can be rebuilt without affecting node data.
- **Provider abstractions per ML role**, defaulting to local but accepting HTTP (OpenAI-compatible) endpoints. API keys live in the OS keychain.
- **Models are downloaded, not bundled.** First-run UX is blocking with Cancel + "Skip (FTS-only)"; cold-start is non-blocking on every subsequent launch.
- **Per-mount kind tag (`general` default) as extension hook**, not a v1 feature in itself. Kept as P1 by user intent.
- **Cmd+K + dedicated search view**, both consuming the same API.
- **Image content gets two parallel processors:** OCR for embedded text and Gemma-3 captioning for visual semantics. The captioner is the dominant disk cost (~5GB) and the user accepted that tradeoff explicitly.
- **v1 platform target is macOS arm64.** macOS x86_64, Linux, and Windows are aspirational and gated on third-party wheel availability — see Dependencies.
- **PyInstaller is the packaging tool** (PyOxidizer is unmaintained since 2022; Nuitka has friction with Rust-extension wheels).

## Dependencies / Assumptions

**Platform support (revised).** v1 ships on **macOS arm64**. The following gaps must be resolved before any other platform is a build target:
- macOS x86_64 — `lancedb` has no macOS x86_64 wheel from 0.26+. Either pin lancedb ≤ 0.25.3, drop Intel Mac support, or build lancedb from source in CI.
- Linux x86_64 — works in principle (paddlepaddle ships manylinux1_x86_64). Bundle size revises to **+500–650 MB** on Linux (paddlepaddle alone is ~186 MB on Linux vs. ~100 MB on macOS).
- Linux arm64 — `paddlepaddle` 3.x has no stable `aarch64` wheel. OCR is unavailable until upstream ships one or we adopt a different OCR engine.
- Windows — paddlepaddle has Windows amd64 wheels; lancedb has Windows wheels. Likely works; not validated.

**Network connectivity** is required at first launch (model download). Subsequent launches are fully offline. The "Skip (FTS-only)" path means the app is *usable* offline at first launch, with degraded search.

**RAM.** With all four models loaded (embedding + reranker + OCR + Gemma captioner), the sidecar's resident memory is roughly **3–6 GB** depending on quantisation. **Recommended minimum: 16 GB system RAM.** 8 GB machines will swap during caption inference. This is a hidden system requirement that the original brainstorm did not surface.

**Tauri sidecar wiring** is not in place today. `tauri-plugin-shell` is registered for `shell:allow-open` (URL opening) only. The three pieces enumerated under Architecture (externalBin, scoped allow-execute, binaries/) are new work in the plan.

**Embedding library.** `fastembed`'s curated ONNX registry as of 0.8.0 does not list `gte-multilingual-base`. Resolution options: (a) export the model to ONNX manually via `optimum-cli` and ship in `binaries/` or load from the user's model cache, or (b) use `sentence-transformers` directly with an `onnxruntime` backend. Decision deferred to planning; the requirement is that the embedding pipeline runs locally with this model, not the specific library.

**Reranker performance budget.** The 300ms latency target is achievable only with: (i) a bounded rerank candidate set (top **15** from retrieval), and (ii) the reranker run as **int8-quantised ONNX**. Both are mandatory for the local default; an HTTP-provider reranker is exempt from the 300ms target.

**Storage layout.** All user data under `~/.cogios/` (`notes/`, `url-cache/`, `search/`, plus `cognios.db`).

## Outstanding Questions

### Resolved during brainstorming and review

- Search vs. RAG question-answering, primary use case, indexed content scope, per-content-type pipeline, embedding strategy, sidecar language, sidecar ownership scope, indexing timing, UI surfaces, result granularity, filter shape, default model choices, model bundling, framework choice, hybrid fallback, indexing-state ownership, sidecar wiring, sidecar auth, path-traversal responsibility, model integrity, API key storage, HTTP provider disclosure, settings UI location, result count cap, palette empty state, accessibility shape, packaging tool, platform target, RAM requirement.

### Deferred to planning (genuine implementation choices)

- **Sidecar lifecycle finer details** — exact backoff schedule for restart-on-crash, exact health-check interval, log-rotation policy.
- **Chunking strategy** — chunk size, overlap, paragraph vs sentence vs sliding window. Measure on real content.
- **FTS5 schema details** — which columns get tokenized, which tokenizer for Chinese mixed content (jieba? icu?).
- **Vector index schema** — lancedb table layout, what metadata travels with each vector.
- **Indexing throughput targets** — measure first; tune queue concurrency.
- **OCR language packs** — PP-OCRv4 mobile defaults; whether Chinese-specific weights need a separate download.
- **Embedding library choice** — fastembed vs sentence-transformers + onnxruntime (see Dependencies).
- **Re-index trigger when user changes embedding model** — full vs incremental (likely full, since dimensions change).
- **Cmd+K visual design / dedicated view fine layout** — design pass during implementation.
- **Progress reporting protocol details** — SSE event schema for download and indexing progress.
- **CSP policy text** — exact directives once the search UI's surface is implemented.

### Sequencing question (product-level, not deferred lightly)

- **When does Q&A / synthesis enter scope?** The original PRD frames CogniOS as AI-native with Chat as a primary surface. v1 ships pure search and an agent-callable API; no LLM is hosted in-app. The trigger for adding synthesis (local or remote LLM behind the Chat surface, consuming the search API) should be a deliberate next-iteration decision, not a drift.

## Next Steps

→ `/ce:plan` for structured implementation planning. The plan should at minimum cover:

1. **Tauri sidecar wiring** — `bundle.externalBin`, scoped `shell:allow-execute`, `binaries/` directory, sidecar supervisor in Rust, `sidecar.runtime` file with port + bearer token, healthz endpoint.
2. **Python sidecar skeleton** — FastAPI app, bearer-token middleware, IPC event handlers, queue subsystem.
3. **ModelManager** — commit-pinned downloads, SHA-256 verification, SSE progress, status state machine, OS-keychain integration for HTTP-provider API keys.
4. **First-run + cold-start UX** — blocking onboarding modal, "Skip (FTS-only)" path, non-blocking warmup hint on subsequent launches.
5. **Indexing pipeline** — per-content-type processors (text, PDF, image-OCR, image-caption, URL pre-stripped), per-job timeouts and memory caps, error isolation, partial-progress reporting.
6. **FTS + vector store + hybrid retrieval + rerank** — int8-quantised reranker, top-15 candidate cap, FTS-only fallback path, partial-mount-index reporting.
7. **Search IPC contract** — Rust ↔ Python HTTP schema, result shape (`degraded`, `partial`, `state` fields), error envelope.
8. **Cmd+K palette UI** — combobox/listbox ARIA, recent-modified empty state, query-syntax help popover, top-15 + "More results" link.
9. **Dedicated search view UI** — filter pickers, sort, pagination.
10. **Settings page** — new `AppSidebar` section, per-role provider config, privacy disclosure, model swap confirmation.
11. **CSP** — define a non-null CSP for `tauri.conf.json` covering the new search-result rendering surfaces.
12. **Cross-platform packaging** — macOS arm64 first; document the Intel-Mac, Linux-arm64, and Windows gaps explicitly.
