---
title: Feature-oriented Settings with provider routing (Phase 1)
type: feat
status: active
date: 2026-05-02
origin: docs/brainstorms/2026-05-02-feature-oriented-settings-requirements.md
---

# Feature-oriented Settings with provider routing (Phase 1)

## Overview

Phase 1 of the brainstorm: replace the model-role-vocabulary Settings card with a feature-vocabulary view, introduce a provider routing layer, ship cloud embedding via OpenAI, and wire first-run auto-download. Phase 2 (image-OCR / image-captioning extractor work — paddleocr + llama-server) is a separate plan to be written when the extractor stack is ready.

The plan deliberately ships everything that can work end-to-end today: semantic search with provider choice (Local GTE / OpenAI), settings persistence, keychain-backed API keys, and a first-run experience that gets a brand-new user from "open the app" to "search works" without visiting Settings. Image OCR / captioning rows appear in the UI but are explicitly disabled with a "available in next release" hint until the Phase 2 plan lands.

## Problem Frame

Today's `Settings → Models` card asks users to manage four model "roles" by hand. Most users don't think in terms of models — they think in features. The brainstorm (origin doc) decided on a three-layer model: **Providers** (configured sources of capability — Local GTE, OpenAI, Qwen, etc.) → **Capabilities** (typed slots — embedding, vision, ocr, reranking) → **Features** (user-facing toggles bound to a provider). One provider can serve many features; one feature has one provider at a time.

Phase 1 of this redesign delivers the routing layer, settings persistence, cloud embedding, and the new Settings UI. Image processors stay stubbed (extractor wiring is Phase 2 territory).

## Requirements Trace

Mapped to the brainstorm's success criteria:

- **R1.** First-run user gets semantic search live within ~30s with no Settings interaction (default: Local GTE auto-download with 5s cancellable banner). *(brainstorm SC-1)*
- **R2.** User can switch the embedding provider from Local GTE to OpenAI in ≤ 5 Settings actions. *(brainstorm SC-2 / Phase 1)*
- **R3.** After configuring an OpenAI key once, every other compatible feature offers OpenAI without re-entering the key. *(brainstorm SC-4)*
- **R4.** Removing a provider from the Providers section reliably disables affected features without crashing the sidecar. *(brainstorm SC-5)*
- **R5.** App restart preserves every setting. *(brainstorm SC-6)*
- **R6.** Settings vocabulary is feature-first; primary Features view contains no `embedding`/`reranker`/`ONNX`/`GGUF` jargon. *(brainstorm SC-7)*
- **R7.** `~/.cogios/search/settings.json` is mode `0600` and contains zero plaintext secrets. *(brainstorm SC-8)*
- **R8.** When sidecar fails to start, Settings UI loads in read-only fallback within ~3s. *(brainstorm SC-9)*
- **R9.** Phase 2 features (Image OCR, Image captioning) appear as disabled rows with a clear "available in next release" hint, not silently absent. *(brainstorm Phase 1 ship value)*
- **R10.** Settings reflect "restart required" honestly when a change affects the dispatcher's wiring. *(brainstorm D8)*

(see origin: `docs/brainstorms/2026-05-02-feature-oriented-settings-requirements.md`)

## Scope Boundaries

**In scope (this plan):**
- Settings persistence (sidecar JSON, mode 0600, schema v1)
- Provider registry + capability declarations for v1 capabilities only (`embedding`, `reranking`, `vision`, `ocr`)
- Cloud embedding via OpenAI (`text-embedding-3-small` with `dimensions=768`)
- Python `keyring` integration in sidecar; new generic Rust IPC commands for provider secrets
- Sidecar restart support + UI surfacing
- New Settings → Features view + Providers section + provider editor slide-out
- First-run workspace banner (5s cancel → download → retry/skip flow)
- Diagnostics relocation of the existing `ModelManagerStatus` card
- Cloud egress consent gate (one-shot per cloud provider)
- Rust-side fallback read of `settings.json` for degraded mode

**Out of scope (deferred to Phase 2 plan):**
- paddleocr extractor wiring → Image OCR feature actually working
- llama-server supervisor + Gemma loader → Image captioning with Local Gemma
- Cloud vision routing for Image captioning (OpenAI / Qwen)
- `LicenseAcceptanceModal` generalization for inline use
- The `chat` capability and any chat feature
- Hot-swap of embedder/extractors (v1 requires sidecar restart on provider change)

**Out of scope (post-v1, per brainstorm):**
- Provider failover / fallback chains
- Cost / token tracking
- Per-document provider routing
- Custom OpenAI-compatible base URL as a first-class provider type (the field is exposed in advanced provider editing but not promoted)
- Multi-dimension embedding schema
- Workspace-scoped settings / cloud sync of settings

## Context & Research

### Relevant Code and Patterns

**Sidecar (Python):**
- `sidecar/search_sidecar/lifecycle.py` — startup ordering; `Dispatcher` constructed once at boot from `select_embedder(model_manager=...)`. Settings load needs to slot in before this point.
- `sidecar/search_sidecar/embeddings/__init__.py` (`select_embedder`) and `sidecar/search_sidecar/embeddings/gte.py` (`GteEmbedder`) — existing factory + concrete embedder. Cloud embedder follows the same `Embedder` Protocol shape from `sidecar/search_sidecar/index/embedder.py`.
- `sidecar/search_sidecar/storage/lancedb_store.py:53` — `EMBEDDING_DIMENSION = 768` lock; `NodeChunk.__post_init__` enforces at write time. Cloud embedder must produce 768-dim vectors.
- `sidecar/search_sidecar/embeddings/reembed.py` — handles same-dimension stub→real swap; provider swap with same dim still works through this path. Different-dim swap requires full table rebuild (out of scope for v1 since OpenAI uses `dimensions=768`).
- `sidecar/search_sidecar/models/manager.py` (`ModelManager`) — local-model lifecycle; the existing `accept_license` / `download` SSE pattern is reused for the workspace banner. Cloud providers do NOT use `ModelManager`; they have their own configuration object.
- `sidecar/search_sidecar/routes/models.py` — uses `dataclasses.asdict` for serialization; `GET /settings` follows the same pattern.
- `sidecar/search_sidecar/runtime_file.py:44` — `os.open(..., 0o600)` pattern used for `sidecar.runtime`. `settings.json` will use the same approach.
- `sidecar/search_sidecar/auth.py` — bearer token middleware; new `/settings` routes inherit it for free.

**Rust:**
- `src-tauri/src/services/secure_storage.rs:23-50` — `set_secret(account, value)`, `get_secret(account)`, `delete_secret(account)` already generic. New commands wrap them with `provider:<id>` accounts.
- `src-tauri/src/commands/secrets.rs` — existing HF-token-only commands; new `provider_secret_*` commands mirror this shape.
- `src-tauri/src/services/search/supervisor.rs` — `start()`, `kill()`, state machine (`SupervisorState`). `restart()` is new.
- `src-tauri/src/commands/search.rs` — existing IPC commands proxy sidecar HTTP. New `get_search_settings` / `update_search_settings` follow this pattern.
- `src-tauri/src/services/search/client.rs` — bearer-token loopback HTTP client; new `settings_get()` / `settings_put()` methods on the client.

**Frontend:**
- `src/app/App.tsx:32-105` — `SettingsModal` mount point inside the existing app shell rendered from `App.tsx`. The new `WorkspaceBanner` mounts adjacent (always-visible). The brainstorm called this "AppShell mount" — same place; this plan uses `App.tsx` consistently as the actual file path.
- `src/features/settings/components/SettingsLayout.tsx` — current Settings layout; this plan replaces the `ModelManagerStatus` card with the new Features + Providers sections and demotes `ModelManagerStatus` to a Diagnostics nested view.
- `src/features/settings/components/ModelManagerStatus.tsx` — current Models card; relocated, not deleted.
- `src/features/settings/hooks/useModelDownloadProgress.ts` — existing SSE hook; lifted to App-level for the banner subscription.
- `src/features/search/types/search.ts` — `SearchClient` interface; extended with `settings()`, `updateSettings()`, `restartSidecar()`, provider-secret methods.
- `src/lib/tauri/ipc.ts` — Tauri IPC bridge; new functions added.
- `src/lib/contracts/search.ts` — TS contracts for `SearchSettings`, `ProviderConfig`, `FeatureConfig`.
- `src/features/explorer/components/ExplorerLayout.tsx:3,245` — existing `openExternal` from `@tauri-apps/plugin-shell` pattern (re-used for the future Open-on-HF link in the provider editor — already shipped from the prior brainstorm).

### Institutional Learnings

- **Snake/camel serde split-form** (commit `ed3e997`): every Rust DTO that crosses the Python/Rust boundary uses `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]`. New DTOs (`SearchSettingsDto`, `ProviderConfigDto`, `FeatureConfigDto`) follow this pattern; round-trip tests are mandatory.
- **Sidecar lock + restart safety** (visible in `lifecycle.py`): the sidecar holds an `fcntl.flock` on `sidecar.lock`. The supervisor's `restart()` must wait for the OS-level file lock to release after `kill()` before `start()` re-acquires it. Without this, the second `start()` can race the first `kill()` and the sidecar comes up immediately failing on lock contention.
- **Default-on-deserialize for legacy payloads** (commit `ca0de87` + `NodeContentChunkDto.role`): every new DTO field that may be absent from older payloads ships with a `#[serde(default)]` so legacy responses still parse.
- **Manifest pinning prerequisite**: Local GTE auto-download in this plan is gated on `pin_manifest.py` having pinned the embedding role's manifest. The user has the script (committed `313acb6`) but has not run it yet for the embedding role; planning assumes it gets run before Unit 4 ships, otherwise R1 fails at runtime with a 404.

### External References

- OpenAI embeddings API supports the `dimensions` request parameter (Matryoshka representation). `text-embedding-3-small` defaults to 1536-dim; passing `"dimensions": 768` returns 768-dim normalized vectors directly. This is the foundation of D3 in the brainstorm.
- Python `keyring` (PyPI) — backend selection: macOS Keychain, freedesktop Secret Service (Linux), Windows Credential Manager. The `cognios-search` service name + `provider:<id>` account naming matches the Rust `keyring` crate's defaults.

### Document Review Findings

The brainstorm went through `/ce:document-review` with 7 personas; the architectural blockers (embedding dimension, sidecar keychain access, dispatcher rebuild) were resolved in revisions before this plan was written. See the brainstorm's "Document review trail" for the full mapping. The deepening pass for *this plan* will catch any decisions still thin.

## Key Technical Decisions

- **Settings schema lives in `sidecar/search_sidecar/settings.py`** as Pydantic `BaseModel`s (not dataclasses — we already use Pydantic for FastAPI request bodies, and `BaseModel.model_validate_json` gives free strict parsing of `settings.json`). Schema includes a `version: int = 1` field; loader rejects unknown future versions so a downgrade from a future build can't silently corrupt state.

- **Provider preset table at `sidecar/search_sidecar/providers/presets.py`** as a module-level dict. Each entry declares `provider_id`, `display_name`, `provider_type` (`local` | `cloud`), `capabilities: tuple[str, ...]`, `default_model_per_capability`, `auth_kind`, optional `base_url`, optional `validation_endpoint`. Adding a future provider is a one-line edit. v1 entries: Local GTE, Local GTE Reranker, Local Gemma, Local paddleocr, OpenAI, Qwen DashScope.

- **Cloud Embedder at `sidecar/search_sidecar/embeddings/openai_compat.py`** — single OpenAI-compatible class for the `/v1/embeddings` shape (covers OpenAI today, future Anthropic/Ollama/etc. when needed). Constructor takes `base_url`, `api_key_provider: Callable[[], str]`, `model: str`, `dimensions: int = 768`. The `api_key_provider` callable defers keychain reads to embed-time, so a key rotation between sidecar boot and first embed is picked up without restart. Sync HTTP via `httpx.Client` — fits the worker-thread `Embedder` Protocol.

- **API key resolution: Python `keyring` library**. Sidecar adds `keyring` to `pyproject.toml` dependencies. Reads via `keyring.get_password("cognios-search", f"provider:{provider_id}")`. Same service name as the Rust `keyring` crate's `SERVICE_NAME` constant in `src-tauri/src/services/secure_storage.rs:17`. No IPC channel between sidecar and Rust for secrets — both processes read the same OS keychain.

  **macOS Keychain ACL caveat**: by default, items written by one process are bound to that process's signing identity, and a second process reading the same item triggers a Security Agent prompt ("X wants to use confidential information stored in 'cognios-search'..."). For a Tauri-bundled app, both Rust and the Python sidecar are children of the same app bundle, so they share the same code-signing identity in production builds — the prompt is not triggered for shared bundle children. In development (sidecar runs via `uv` from the system Python), the prompt WILL trigger on first cross-process read; user clicks "Always Allow" once. Document this in dev-onboarding notes; in production, verify the bundle's code-signing scope covers the sidecar binary.

  **Linux headless caveat**: Python `keyring`'s default backend on Linux requires a Secret Service daemon (gnome-keyring / KWallet / KeePassXC). On headless CI / server installs without one, `keyring.get_password` returns `None` or raises. Mitigation for v1: add `keyrings.alt` as an optional dev-only dependency for CI; document the production runtime requirement (Secret Service daemon present); the cloud-embedding path degrades gracefully to a clear "API key not retrievable" error rather than crashing.

- **Restart mechanism: Rust supervisor adds `restart(&self: &Arc<Self>, app: &AppHandle)`** (must take `AppHandle` because `start()` does, and `restart()` must be able to call `start()`). Sequence: send SIGTERM via the supervisor's existing `terminate_orphan_if_alive` helper (graceful) → wait up to `ORPHAN_SIGTERM_GRACE` (~3s) for the sidecar's `finally` block in `lifecycle.py` to cleanly close `indexing_runner`, drain `queue.db`, remove the runtime file, and release `sidecar.lock` → fall back to `child.kill()` (SIGKILL) only if grace expired → poll `process_is_alive(pid)` from `runtime_file.py` until the OS reaps the process and the kernel releases the flock → `start()`. The `kill()` shortcut path used today (which sets `Stopped` synchronously before the OS exits) is bypassed by the restart flow because that synchronous-state shortcut is what makes "wait for state to leave Running" vacuous as a gate. UI calls a new `restart_sidecar` IPC command which awaits both kill confirmation and runtime-file rewrite before returning. Brand-new `Restarting` supervisor state for the in-between.

- **Settings change detection: sidecar tracks a `boot_settings_hash`** computed at startup; `PUT /settings` compares the new settings to this hash, sets `needs_restart: true` in the GET response if they differ in dispatcher-affecting fields. Affecting fields: any `feature.provider_id` change, any provider's `default_model_per_capability` for embedding (post-v1), enabling/disabling any feature. Affecting fields list is concrete and small.

- **Mixed-provider data corruption guard.** Once `needs_restart == true`, the sidecar's IndexingRunner stops claiming new jobs (a new `runner.set_paused(True)` flag controlled by the route layer). In-flight jobs complete on the old embedder; new ones queue up. The Settings UI surfaces "Indexing paused — restart to apply new provider" inline. Once the user confirms the restart, the new sidecar boots with the new provider and unpauses. This prevents the silent case where chunks indexed by GTE 768-dim and OpenAI 768-dim coexist in the same table (same dimension, different embedding spaces — dot-product similarity is meaningless across them). v1 does NOT cross-provider-re-embed existing chunks (the `reembed_stale_chunks` sweep only handles zero-vector stubs, not provider-stale chunks); a separate v2 plan that adds an `embedder_id` column on chunks would unlock that.

- **Resync + retry attempt cap.** The Rust forwarder re-queues every non-`indexed` job on each sidecar startup (`forwarder.rs:312`); `queue.enqueue` resets ERROR rows to PENDING. With OpenAI 401/429 + the in-progress runner busy-loop, this means restart-after-restart could replay 1000s of failed cloud calls. v1 caps `attempts` at **3** in the runner: when a job's `attempts >= 3`, the runner skips it (does NOT mark error again so the resync re-forward doesn't re-arm it; but does NOT mark indexed either; net effect: the job stays in ERROR with `attempts == 3` and the resync's re-enqueue path is gated on `attempts < 3` for the new pending state). The cap is a small change to `runner.py` and `queue.py.enqueue`. Surfacing the giving-up state is a follow-up; v1's behavior is "stops trying after 3 attempts; visible in queue status as count-of-errors".

- **Workspace banner mount point: `src/app/App.tsx`** as a sibling of `SettingsModal`. Subscribes to `models/progress` SSE on mount via the lifted `useModelDownloadProgress` hook; renders nothing while idle. State machine: `idle` → `consent` (5s countdown) → `downloading` → `done` (auto-dismiss 2s) → `failed` (retry/skip) → `skipped` (persistent until user opens Settings).

- **Provider editor: slide-out panel adjacent to the row**, not a modal. Reasons: keeps Settings context visible, supports inline-from-feature-row UX cleanly, easier focus management than modal-on-modal. Single component (`ProviderEditor.tsx`) reused by both inline-from-row and Providers-section entry points.

- **Cloud egress consent: per-provider one-shot**. Stored in `settings.json` as `cloud_consent_acked: ["openai"]`. First time a user picks a cloud provider for any feature, a confirmation dialog appears: "All indexed content for {feature} will be sent to {provider}'s servers when this feature is active. Continue?" Persists across all features for that provider.

- **API key masking: `<prefix>...XXXX`** where `<prefix>` is the longest common per-provider prefix (`sk-` for OpenAI, `sk-` for DeepSeek-style; configurable in preset). XXXX = last 4 characters. Enough to distinguish two keys, short enough not to leak meaningful entropy.

- **Phase 2 feature row treatment: visible-but-disabled** with `Available in next release` hint text. Not hidden — users see the conceptual model and know what's coming. Toggle is rendered greyed-out (cannot be flipped on); provider picker is absent. This satisfies R9 and avoids the "I don't see Image OCR anywhere" support question.

- **Diagnostics relocation, not deletion**: `ModelManagerStatus` is moved to `Settings → Advanced → Diagnostics`, accessed via a small "Diagnostics" link in the Settings header. Useful as a debug surface during phase 1 rollout; reviewable for removal once telemetry shows no users open it.

## Open Questions

### Resolved During Planning

- **Settings module location** — `sidecar/search_sidecar/settings.py` (Pydantic BaseModel for request/response shapes; underlying file I/O lives there too). Tests at `sidecar/tests/test_settings.py`.
- **Provider preset location** — `sidecar/search_sidecar/providers/presets.py`; package init at `sidecar/search_sidecar/providers/__init__.py`. New `providers` package keeps it separate from the existing `models/` package, which is local-model-lifecycle-specific.
- **Cloud embedder file location** — `sidecar/search_sidecar/embeddings/openai_compat.py` (sibling of existing `gte.py`).
- **Banner component location** — `src/app/components/WorkspaceBanner.tsx` (new `app/components/` directory; the banner is app-shell-scoped, not feature-scoped).
- **TS contracts location** — `SearchSettings`, `ProviderConfig`, `FeatureConfig` types in existing `src/lib/contracts/search.ts`.
- **Rust restart commands location** — `src-tauri/src/commands/search.rs` (alongside existing search commands; supervisor restart is logically a search-subsystem operation).
- **Provider preset hardcoded vs dynamic** — hardcoded in v1. Hot-loadable preset registration is post-v1.
- **Schema versioning** — `version: 1` field at top level; loader rejects `version > 1`; future schema bumps add a migration step.

### Deferred to Implementation

- **Exact `httpx.Client` configuration for the cloud embedder** — connection pool size, retry policy, timeouts. Defaults are fine for v1; real values come from observed behavior.
- **Per-provider validation endpoint shape** — `OpenAI: GET /v1/models` is documented; Qwen DashScope's compat-mode path is similar but the exact URL belongs in the preset table at implementation time.
- **`ModelManager.download()` SSE event reuse** — the workspace banner subscribes to the same `models/progress` event. Whether the banner needs a parallel feed for cloud-provider validation events is decidable once the validation flow is implemented.
- **Restart timing** — how long the supervisor's `kill()` → `start()` cycle takes in practice; the UI's "Reconnecting..." spinner timeout. Estimate ~2-3s; real value comes from manual measurement.
- **Whether the OpenAI client adapter retries 429s** — likely yes with exponential backoff, but exact backoff schedule is a runtime concern.
- **Concrete "needs restart" change-detection field list** — currently described conceptually; final list of dispatcher-affecting fields gets pinned during Unit 3 implementation by tracing what Dispatcher and Embedder construction actually read from settings.
- **Brainstorm "audit log" deferred-to-planning item** — explicitly **NOT** included in v1 (out-of-scope deferred to a follow-up plan). Rationale: append-only log file + rotation is genuinely useful for the "did I add this provider?" forensics question, but adds non-trivial implementation surface (rotation policy, format choice, max size, no read API in v1). Defer until either a security incident motivates it or telemetry shows users actually need it.
- **Brainstorm "provider deletion in-flight job cancel" deferred-to-planning item** — v1 ships with the documented behavior: in-flight embeddings using a deleted provider's key fail with "key missing", marking the job ERROR, and the next sidecar restart re-queues the failed jobs (which then either succeed under the replacement provider or surface a clear "no provider" state via StubEmbedder). The proper cancel-signal flow is deferred to the same follow-up plan that adds in-process embedder hot-swap. The risk and behavior are documented in System-Wide Impact.
- **"Set up in Settings" CTA handler from skipped banner state** — the CTA navigates the user into Settings → Features and visually highlights the Semantic search row. The download itself triggers via the standard provider-pick path (re-selecting `local-gte` flips the row into "downloading" inline). The banner's `skipped` state stays visible until `client.settings()` reflects either a download-in-progress (`models/progress` SSE shows `state="downloading"`) or `first_run_skipped: false` (user re-engaged), at which point it transitions back to `idle`.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌──────────────────────────── Frontend ────────────────────────────┐
│                                                                   │
│   App.tsx                                                         │
│     ├── WorkspaceBanner (subscribes to models/progress SSE)       │
│     │     states: idle → consent → downloading → done             │
│     │             → failed → skipped                              │
│     └── SettingsModal                                             │
│           └── SettingsLayout                                      │
│                 ├── FeaturesList                                  │
│                 │     ├── FeatureRow(role=embedding, mandatory)   │
│                 │     ├── FeatureRow(role=reranking)              │
│                 │     ├── FeatureRow(role=ocr, disabled "next release")│
│                 │     └── FeatureRow(role=vision, disabled "next release")│
│                 ├── ProvidersSection                              │
│                 │     └── ProviderRow(s) — Add/Edit/Remove        │
│                 ├── RestartRequiredBanner (when settings dirty)   │
│                 └── DiagnosticsLink → ModelManagerStatus (relocated)│
│                                                                   │
└──────────────────────────────┬────────────────────────────────────┘
                               │ Tauri IPC
                ┌──────────────▼──────────────┐
                │           Rust              │
                │                             │
                │  commands/search.rs         │
                │    get_search_settings      │
                │    update_search_settings   │
                │    restart_sidecar          │
                │  commands/secrets.rs        │
                │    set_provider_secret      │
                │    get_provider_secret_present│
                │    delete_provider_secret   │
                │                             │
                │  services/search/           │
                │    supervisor.rs            │
                │      start() / kill() /     │
                │      restart() (new)        │
                │    client.rs                │
                │      settings_get/put       │
                │  services/secure_storage.rs │
                │      (already generic)      │
                └──────────────┬──────────────┘
                               │ loopback HTTP (bearer)
                ┌──────────────▼──────────────┐
                │          Sidecar            │
                │                             │
                │  routes/settings.py (new)   │
                │    GET  /settings           │
                │    PUT  /settings           │
                │                             │
                │  settings.py (new)          │
                │    SearchSettings (pydantic)│
                │    load() / save() (0600)   │
                │                             │
                │  providers/presets.py (new) │
                │    PRESETS: dict[id, …]     │
                │                             │
                │  embeddings/openai_compat.py│
                │    OpenAICompatEmbedder     │
                │      (768-dim hard-validated)│
                │                             │
                │  embeddings/__init__.py     │
                │    select_embedder routes   │
                │    based on settings        │
                │                             │
                │  lifecycle.py               │
                │    load settings → wire     │
                │    embedder + dispatcher    │
                │                             │
                │  ┌──── OS keychain ─────┐   │
                │  │ service: cognios-search│  │
                │  │ accounts:             │  │
                │  │   provider:openai     │  │
                │  │   provider:qwen       │  │
                │  │   hf-token (existing) │  │
                │  └───────────────────────┘  │
                └─────────────────────────────┘
```

State machine for the workspace first-run banner:

```
        ┌───────┐  app first launch
        │ idle  │──────────────────────┐
        └───────┘                       ▼
            ▲                  ┌──────────────┐  cancel       ┌──────────┐
            │ download done    │   consent    │──────────────▶│ skipped  │
            │ (auto-dismiss 2s)│ (5s countdown)│               │(persist) │
            │                  └──────┬───────┘               └─────┬────┘
            │                         │ 5s elapse                  │
       ┌────┴────┐                    ▼                            │ user
       │   done  │             ┌──────────────┐  fail (×3 auto)   │ opens
       └─────────┘             │ downloading  │──────┐            │ Settings
            ▲                  └──────┬───────┘      ▼            │
            │ success                 │       ┌──────────────┐    │
            │                         │       │   failed     │    │
            │                         │       │  (retry/skip)│    │
            └─────────────────────────┘       └──────┬───────┘    │
                                                     │            │
                                                     └────────────┘
```

## Implementation Units

- [x] **Unit 1: Sidecar settings persistence (schema + routes + file I/O)** — shipped in commit `e86cf14`

**Goal:** A single source of truth for search settings on disk, accessible via authenticated HTTP. Foundation for everything else.

**Requirements:** R5, R7

**Dependencies:** None.

**Files:**
- Create: `sidecar/search_sidecar/settings.py` — `SearchSettings` Pydantic model + `ProviderConfig` + `FeatureConfig` + `load_settings(path)` + `save_settings(path, settings)` + helpers
- Create: `sidecar/search_sidecar/routes/settings.py` — `GET /settings`, `PUT /settings` FastAPI router
- Modify: `sidecar/search_sidecar/app.py` — register new router on `app.include_router`
- Modify: `sidecar/search_sidecar/lifecycle.py` — call `load_settings(search_dir / "settings.json")` after `prepare_search_dir`; pass into `app.state.search_settings`
- Test: `sidecar/tests/test_settings.py`
- Test: `sidecar/tests/test_settings_routes.py`

**Approach:**
- Pydantic `BaseModel`s mirror the JSON shape: `SearchSettings { version: int = 1, providers: dict[str, ProviderConfig], features: dict[str, FeatureConfig], cloud_consent_acked: list[str], first_run_skipped: bool = False }`. The `first_run_skipped` field tracks whether the user dismissed the first-run download banner; consumed by Unit 5's banner state machine to suppress re-prompting on app launch. `ProviderConfig` carries `provider_id`, `enabled`, `api_key_ref` (optional, format `keychain://cognios-search/provider:<id>`), `base_url` (optional override), `model_per_capability` (optional override). `FeatureConfig` carries `enabled`, `provider_id` (optional — None for unconfigured feature).
- `load_settings(path)`: returns defaults (`SearchSettings()` with seeded `providers={"local-gte": ProviderConfig(...)}` and `features={"semantic-search": FeatureConfig(enabled=True, provider_id="local-gte"), ...}`) when file is absent; refuses to load if `version > CURRENT_VERSION`.
- `save_settings(path, settings)`: writes via `os.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)` + `json.dump`. Idempotent. Atomic-ish: write to `<path>.tmp` then `os.replace` for crash safety.
- `GET /settings`: returns the current settings + a computed `needs_restart` flag (initially False; updated by Unit 3).
- `PUT /settings`: validates incoming JSON against `SearchSettings`, replaces the on-disk file, returns the persisted state. Bearer auth inherited.

**Patterns to follow:**
- Existing FastAPI router shape in `sidecar/search_sidecar/routes/index.py`
- File-mode-0600 pattern in `sidecar/search_sidecar/runtime_file.py:44`
- Pydantic model + `model_dump_json()` pattern from existing API request bodies

**Test scenarios:**
- *Happy path:* `load_settings` on missing file returns defaults with semantic-search bound to local-gte provider.
- *Happy path:* `save_settings` writes the file with mode 0600 (verified via `stat`); subsequent `load_settings` round-trips identical content.
- *Happy path:* `GET /settings` returns the current settings JSON; bearer-token-required.
- *Happy path:* `PUT /settings` with valid payload persists and returns the new state.
- *Edge case:* Concurrent `save_settings` calls do not corrupt the file (atomic replace via tmp + rename).
- *Edge case:* `load_settings` on a file with `version: 99` raises a clear error rather than silently downgrading.
- *Edge case:* Malformed JSON returns a 400 from `PUT /settings`, not a 500.
- *Edge case:* PUT preserves unknown fields it doesn't validate against (forward-compat for future-version sidecar reads of older clients).
- *Error path:* `PUT /settings` without bearer token returns 401.
- *Integration:* sidecar boot loads settings before app build; `app.state.search_settings` is populated for downstream use.

**Verification:**
- `curl -H 'Authorization: Bearer <token>' http://127.0.0.1:<port>/settings` returns valid JSON with the seeded defaults on a fresh workspace.
- `stat ~/.cogios/search/settings.json` shows mode `0600`.

---

- [x] **Unit 2: Provider registry + cloud embedder + Python keyring access** — shipped in commit pending

**Goal:** Sidecar knows what providers exist (preset table), can read API keys from the OS keychain, and can call OpenAI's `/v1/embeddings` to produce 768-dim vectors. Cloud embedding works end-to-end at the sidecar level.

**Requirements:** R2, R3, R6

**Dependencies:** Unit 1.

**Files:**
- Create: `sidecar/search_sidecar/providers/__init__.py`
- Create: `sidecar/search_sidecar/providers/presets.py` — `PRESETS: dict[str, ProviderPreset]`; `ProviderPreset` dataclass
- Create: `sidecar/search_sidecar/providers/keychain.py` — thin wrapper around `keyring.get_password` with logging + error handling
- Create: `sidecar/search_sidecar/embeddings/openai_compat.py` — `OpenAICompatEmbedder` class implementing `Embedder` Protocol
- Modify: `sidecar/search_sidecar/embeddings/__init__.py` — extend `select_embedder` to route based on `SearchSettings.features["semantic-search"].provider_id`; if cloud provider, instantiate `OpenAICompatEmbedder` with the right preset
- Modify: `sidecar/pyproject.toml` — add `keyring>=24.0,<26.0` (current 25.x is API-compatible) and add an explicit `pydantic>=2.0,<3.0` declaration since the new `settings.py` calls Pydantic v2 methods (`model_dump_json`, `model_validate_json`); v2 is currently transitively pulled in via FastAPI but should be declared directly so it can't disappear out from under us.
- Test: `sidecar/tests/test_providers_presets.py`
- Test: `sidecar/tests/test_providers_keychain.py`
- Test: `sidecar/tests/test_openai_compat_embedder.py`
- Test: `sidecar/tests/test_select_embedder_routing.py`

**Approach:**
- `ProviderPreset` dataclass: `provider_id`, `display_name`, `provider_type` (`"local"` | `"cloud"`), `capabilities` (frozenset of capability names), `default_model_per_capability` (dict), `auth_kind` (`"none"` | `"hf-token"` | `"api-key"`), `base_url` (optional), `validation_endpoint` (optional, e.g. `"/v1/models"`).
- v1 `PRESETS`: `local-gte`, `local-gte-reranker`, `local-gemma`, `local-paddleocr`, `openai`, `qwen-dashscope`. Each declares its capability set per the brainstorm matrix.
- `OpenAICompatEmbedder`: takes `base_url`, `api_key_provider: Callable[[], str]` (lazy resolution at first call to keep keychain reads minimal), `model: str`, `dimensions: int = 768`. `embed(texts)` POSTs `{"model": ..., "input": [...], "dimensions": 768}` to `{base_url}/embeddings`. Validates response: array length == input length, every vector length == 768, every element is a float. Hard error on any mismatch (no silent skip — addresses the reembed-sweep dimension-mismatch finding from the brainstorm review).
- `select_embedder(settings, model_manager)`: looks at `settings.features["semantic-search"].provider_id`; if it matches a cloud preset, instantiate `OpenAICompatEmbedder(...)`; if local, fall back to existing `GteEmbedder` selection logic; if no provider configured (skipped first-run), return `StubEmbedder`.

**Patterns to follow:**
- `Embedder` Protocol shape in `sidecar/search_sidecar/index/embedder.py`
- Existing `GteEmbedder` class structure in `sidecar/search_sidecar/embeddings/gte.py`
- Existing `select_embedder` factory pattern in `sidecar/search_sidecar/embeddings/__init__.py`

**Test scenarios:**
- *Happy path:* `PRESETS["openai"]` declares capability `"embedding"` with default model `text-embedding-3-small`.
- *Happy path:* `OpenAICompatEmbedder.embed(["hello", "world"])` → mocked HTTP returns 2 vectors of 768 floats → returns those vectors normalized as `list[list[float]]`.
- *Happy path:* `select_embedder` with settings binding `semantic-search` to `openai` and `OPENAI_API_KEY` available in keychain → returns an `OpenAICompatEmbedder`.
- *Happy path:* `select_embedder` with settings binding to `local-gte` → returns existing GteEmbedder behavior unchanged.
- *Happy path:* `select_embedder` with no provider bound → returns `StubEmbedder`.
- *Edge case:* `OpenAICompatEmbedder.embed([])` returns `[]` without an HTTP call.
- *Edge case:* Keychain has no key for `provider:openai` → `api_key_provider()` raises a clear error; embed surfaces it as a `RuntimeError("OpenAI API key missing — configure in Settings")`.
- *Error path:* Mocked HTTP returns vector length 1536 (provider ignored `dimensions=768`) → `OpenAICompatEmbedder.embed` raises `ValueError`, does NOT silently store wrong-dim data. Asserts the message names the dimension mismatch.
- *Error path:* Mocked HTTP returns 401 (invalid key) → embed raises `RuntimeError` containing "OpenAI" + "401"; not silently swallowed.
- *Error path:* HTTP timeout → embed raises a `RuntimeError`; the indexing runner sees this as a job failure (matches existing semantics for embedder errors).
- *Edge case:* Concurrent `embed` calls on the same `OpenAICompatEmbedder` instance use the same lazy-loaded API key (no double keychain read).
- *Integration:* `keyring.get_password("cognios-search", "provider:openai")` against a stubbed keyring backend (using `keyring.backend.test.TestKeyring` or similar) returns the stored value; the wrapper at `providers/keychain.py` propagates it.

**Verification:**
- A test sidecar started against a fixture HTTP server (responding to `/v1/embeddings` with 768-dim vectors) and a stub keychain backend produces non-zero embedding vectors for ImageProcessor / TextProcessor jobs.
- Validation: write a PoC where the test sidecar is configured for `openai` provider, indexes one note, runs a search, and the snippet is from the cloud-embedded chunk.

---

- [ ] **Unit 3: Sidecar restart-required signaling + dispatcher rebuild from settings**

**Goal:** When a settings change requires a dispatcher rebuild (provider swap), the sidecar reflects this in its `GET /settings` response. The dispatcher already rebuilds on next boot from the freshly loaded settings — this unit makes sure the boot-time wiring honors the settings file.

**Requirements:** R10

**Dependencies:** Unit 1, Unit 2.

**Files:**
- Modify: `sidecar/search_sidecar/settings.py` — add `boot_signature(settings)` helper that hashes the dispatcher-affecting subset of settings (feature/provider bindings, cloud provider models)
- Modify: `sidecar/search_sidecar/routes/settings.py` — `GET /settings` includes `needs_restart: bool` computed by comparing current on-disk settings to the captured boot signature in `app.state.boot_settings_signature`
- Modify: `sidecar/search_sidecar/lifecycle.py` — capture `boot_settings_signature` after `load_settings`; pass `settings` to `Dispatcher` construction (Dispatcher reads features and wires the right embedder)
- Modify: `sidecar/search_sidecar/index/dispatch.py` — accept `settings` parameter; pass through `select_embedder(settings, ...)`
- Test: `sidecar/tests/test_needs_restart.py`
- Modify test: `sidecar/tests/test_lancedb_store.py` (only if existing tests assume Dispatcher constructor signature — extend if needed)

**Approach:**
- `boot_signature` is a deterministic hash (SHA-256 hex truncated to 16 chars) of a normalized JSON serialization of the dispatcher-affecting fields: each `feature.provider_id`, each provider's `model_per_capability`, and the `enabled` flag of each feature.
- On lifecycle boot: `boot_sig = boot_signature(loaded_settings)`; `app.state.boot_settings_signature = boot_sig`.
- On `PUT /settings`: persist new settings; compute new signature; `needs_restart = (new_sig != app.state.boot_settings_signature)`.
- On `GET /settings`: include `needs_restart` field by recomputing `boot_signature(current_settings)` and comparing to `app.state.boot_settings_signature`.
- Dispatcher constructor takes `settings: SearchSettings`; uses `select_embedder(settings, model_manager)` instead of the previous parameterless call.

**Patterns to follow:**
- Existing `Dispatcher.__init__` shape in `sidecar/search_sidecar/index/dispatch.py`
- Existing `app.state` slot pattern in `sidecar/search_sidecar/app.py`

**Test scenarios:**
- *Happy path:* Fresh settings → `boot_signature(s) == boot_signature(s)` (deterministic).
- *Happy path:* `GET /settings` immediately after boot returns `needs_restart: false`.
- *Happy path:* `PUT /settings` with same content → next `GET` still `needs_restart: false`.
- *Happy path:* `PUT /settings` changing `features["semantic-search"].provider_id` from `"local-gte"` to `"openai"` → next `GET` returns `needs_restart: true`.
- *Edge case:* Changing `cloud_consent_acked` (a non-dispatcher field) does NOT trigger `needs_restart`.
- *Edge case:* Changing a provider's `api_key_ref` (key rotated) does NOT trigger `needs_restart` — the cloud embedder re-reads the key lazily.
- *Edge case:* Toggling an optional feature off → `needs_restart: true` (extractor wiring may change).
- *Integration:* On sidecar boot with settings binding `semantic-search` to `openai`, `Dispatcher` is constructed with an `OpenAICompatEmbedder` (verified via the type of the embedder in the dispatcher's processor list).

**Verification:**
- `curl -H 'Authorization: Bearer <token>' http://127.0.0.1:<port>/settings | jq .needs_restart` returns `false` after boot, `true` after a provider swap PUT.

---

- [ ] **Unit 4: Rust IPC commands + supervisor restart + secure_storage extension + degraded-mode fallback read**

**Goal:** The frontend can read/write settings, restart the sidecar, and manage provider secrets through Tauri commands. When the sidecar fails to start, the frontend can still read `settings.json` directly through Rust for a read-only view.

**Requirements:** R2, R4, R5, R8, R10

**Dependencies:** Unit 1, Unit 2, Unit 3.

**Files:**
- Create: `src-tauri/src/commands/search_settings.rs` — new commands `get_search_settings`, `update_search_settings`, `restart_sidecar`
- Modify: `src-tauri/src/commands/secrets.rs` — add `set_provider_secret`, `get_provider_secret_present`, `delete_provider_secret` commands (delegate to existing `secure_storage::set/get/delete_secret` with `provider:<id>` accounts)
- Modify: `src-tauri/src/services/search/supervisor.rs` — add `restart()` method; new `SupervisorState::Restarting` variant
- Modify: `src-tauri/src/services/search/client.rs` — add `settings_get(&self) -> SidecarEnvelope<SearchSettingsDto>`, `settings_put(&self, body: SearchSettingsDto) -> SidecarEnvelope<SearchSettingsDto>` methods + DTOs (`SearchSettingsDto`, `ProviderConfigDto`, `FeatureConfigDto`)
- Create: `src-tauri/src/services/search/settings_fallback.rs` — synchronous direct read of `settings.json` for degraded mode (no sidecar dependency)
- Modify: `src-tauri/src/lib.rs` — register the new commands
- Modify: `src-tauri/capabilities/default.json` — extend allowlist if needed (the existing entries probably cover internal commands; verify)
- Test: `src-tauri/src/services/search/client.rs` — add round-trip serde tests for new DTOs (mirrors existing `model_role_status_round_trips_snake_to_camel` pattern)
- Test: `src-tauri/src/services/search/supervisor.rs` — add tests for `restart()` happy path + kill-fails-then-start path
- Test: `src-tauri/src/services/search/settings_fallback.rs` — happy path read, missing-file returns default, malformed file surfaces an error
- Test: `src-tauri/tests/search_settings_commands.rs` (or similar integration suite if one exists) — command registration smoke tests

**Approach:**
- New DTOs use the established `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]` split-form. Optional fields use `#[serde(default)]` for legacy-payload safety. `SearchSettingsDto` includes the computed `needs_restart: bool` field surfaced by Unit 3's sidecar route — Rust must declare and pass it through verbatim so the frontend can drive the restart-required UX.
- `restart_sidecar` command: Rust calls `supervisor.restart()` (blocking up to ~5s), waits for the new `sidecar.runtime` file to be readable + parseable, then returns. Returns `Ok(())` on success or `Err(String)` describing the failure mode.
- `supervisor.restart()`: sequence is `kill()` → wait for `SupervisorState` to leave `Running` → poll for `sidecar.lock` to be released (up to 3s) → `start()` → wait for `SupervisorState::Running` (up to 5s). On any failure: return error preserving the supervisor's last state for logging.
- `set_provider_secret(input: { provider_id, secret })`: validates `provider_id` is non-empty + matches `[a-z][a-z0-9-]*` (defense in depth against weird account names); calls `secure_storage::set_secret(format!("provider:{}", provider_id), &secret)`.
- `get_provider_secret_present(provider_id)`: returns `bool` only (never the value — same pattern as `has_hf_token`).
- `delete_provider_secret(provider_id)`: calls `secure_storage::delete_secret`. Idempotent (no error if account doesn't exist).
- `settings_fallback::read(storage_dir)`: synchronously reads `<storage_dir>/search/settings.json` and parses as `SearchSettingsDto`. Returns `Result<SearchSettingsDto, String>`. Used by `get_search_settings` when the sidecar is unreachable: try the sidecar first, fall back to direct file read on connection failure.
- Bearer token for HTTP: existing `client.rs` reads from `sidecar.runtime`; same auth flow.

**Patterns to follow:**
- Existing command structure in `src-tauri/src/commands/search.rs`
- Existing serde split-form DTOs in `src-tauri/src/services/search/client.rs`
- Existing supervisor state-machine pattern in `src-tauri/src/services/search/supervisor.rs`
- Existing `secrets.rs` command shape

**Test scenarios:**
- *Happy path:* `get_search_settings` against a running sidecar returns the parsed `SearchSettingsDto`.
- *Happy path:* `update_search_settings` with a new provider binding persists and returns the new state; subsequent GET shows the change.
- *Happy path:* `restart_sidecar` against a running sidecar successfully cycles the process; `get_search_settings` works again afterward; `needs_restart` resets to `false`.
- *Happy path:* `set_provider_secret` writes to keychain; `get_provider_secret_present` returns `true`; `delete_provider_secret` clears it; subsequent `get_provider_secret_present` returns `false`.
- *Edge case:* `set_provider_secret` with empty secret returns an error (matches `set_hf_token` validation).
- *Edge case:* `set_provider_secret` with bad provider_id (uppercase, special chars) returns a validation error.
- *Edge case:* `get_search_settings` while sidecar is restarting returns the fallback (direct file read); response is flagged with a `degraded: true` field so the UI knows.
- *Error path:* `restart_sidecar` with kill failing surfaces the error; supervisor state ends in `Failed`; UI sees the error.
- *Error path:* `update_search_settings` with malformed body returns a structured error from the sidecar; Rust passes it through.
- *Integration (round-trip):* JSON `{"providers": {"openai": {"providerId": "openai", "enabled": true, ...}}, ...}` decodes to `SearchSettingsDto`; re-serializing produces camelCase top-level fields and preserves all values.
- *Integration (fallback read):* with sidecar killed, `get_search_settings` returns the direct-from-file content within ~500ms.

**Verification:**
- Manual: kill the sidecar process, click "Refresh" in Settings UI, confirm read-only view loads with the `Sidecar unavailable` banner.
- Cargo test suite passes for all new modules.

---

- [ ] **Unit 5: Frontend SearchClient extensions + workspace banner + restart UX**

**Goal:** TS contracts, IPC bindings, and the always-visible workspace banner for first-run download. The banner runs the consent → download → done/failed/skipped state machine. A separate Restart confirmation modal handles provider-swap restarts triggered from Settings.

**Requirements:** R1, R2, R5, R10

**Dependencies:** Unit 4.

**Files:**
- Modify: `src/lib/contracts/search.ts` — add types: `SearchSettings`, `ProviderConfig`, `FeatureConfig`, `ProviderId`, `CapabilityName`
- Modify: `src/features/search/types/search.ts` — extend `SearchClient` interface: `settings()`, `updateSettings(partial: Partial<SearchSettings>)`, `restartSidecar()`, `setProviderSecret(input)`, `hasProviderSecret(providerId)`, `deleteProviderSecret(providerId)`
- Modify: `src/lib/tauri/ipc.ts` — add `getSearchSettings`, `updateSearchSettings`, `restartSidecar`, `setProviderSecret`, `getProviderSecretPresent`, `deleteProviderSecret`
- Modify: `src/features/search/api/searchClient.ts` — implement the new SearchClient methods
- Create: `src/app/components/WorkspaceBanner.tsx` — banner component; subscribes to `models/progress` SSE; runs the state machine
- Create: `src/app/components/WorkspaceBanner.test.tsx`
- Modify: `src/app/App.tsx` — mount `WorkspaceBanner` adjacent to `SettingsModal`
- Lift `useModelDownloadProgress`: keep the hook in `src/features/settings/hooks/useModelDownloadProgress.ts`; the banner subscribes via the same hook (no need to physically move it)
- Create: `src/features/settings/components/RestartConfirmation.tsx` — confirmation dialog used by Settings before triggering `restartSidecar()`
- Create: `src/features/settings/components/RestartConfirmation.test.tsx`
- Modify: `src/features/settings/components/SettingsLayout.tsx` — read the `needs_restart` field from settings; render an inline `RestartRequiredBanner` (small component, can live in the same file) with a button that opens the confirmation modal
- Modify: `src/features/search/api/searchClient.test.ts` — add tests for the new methods using existing mocked-invoke pattern

**Approach:**
- New TS types are mechanical mirrors of the Rust DTOs from Unit 4 (camelCase). `SearchSettings.needsRestart` is a top-level boolean.
- `WorkspaceBanner` state machine matches the high-level design above. Internal state via `useReducer`. Effects:
  - On `idle`, listen for the first first-run signal: settings response with `features["semantic-search"].providerId === "local-gte"` AND a missing local model file (detected via the existing models/status feed). If present, transition to `consent`.
  - `consent` state shows "Setting up local search engine (75 MB from huggingface.co). Cancel — starting in {N}s..." with a 5-second `setInterval` countdown; click Cancel transitions to `skipped`.
  - On 5s elapse, transition to `downloading` and call `startModelDownload({ role: "embedding" })`. Subscribe to SSE progress.
  - `downloading` shows percent. On `state: "ready"` event → `done`. On `state: "error"` event → `failed` after auto-retrying up to 3 times.
  - `failed` shows "Setup failed — Retry / Skip and use basic search".
  - `skipped` shows persistent "Semantic search not configured — Set up in Settings" with a button that opens SettingsModal. Persists via `updateSettings({ first_run_skipped: true })` (field declared in Unit 1's schema). On app relaunch, the banner reads this flag from `client.settings()` and short-circuits to the `skipped` state instead of re-running the consent countdown.
- `RestartConfirmation` modal: triggered when user clicks the "Restart sidecar to apply" button in Settings. Shows "Sidecar will restart. This takes ~3 seconds. Continue?" → on confirm, calls `restartSidecar()`, shows a spinner labeled "Reconnecting...", then `await client.settings()` to confirm the restart succeeded; closes on success or shows an error.
- A `Restart required` banner (just a small `<p>` with a button) lives inline in `SettingsLayout` when `settings.needsRestart === true`. Opens the `RestartConfirmation` modal.

**Patterns to follow:**
- Existing `useModelDownloadProgress` hook in `src/features/settings/hooks/useModelDownloadProgress.ts`
- Existing IPC pattern in `src/lib/tauri/ipc.ts`
- Existing test mocking pattern in `src/features/search/api/searchClient.test.ts` (mocked `invoke`)
- Existing modal pattern from `src/features/settings/components/LicenseAcceptanceModal.tsx`

**Test scenarios:**
- *Happy path (SearchClient):* `client.settings()` returns the parsed `SearchSettings` from a mocked `invoke` response.
- *Happy path (SearchClient):* `client.updateSettings({ features: ... })` calls `invoke("update_search_settings", ...)` with the payload.
- *Happy path (SearchClient):* `client.restartSidecar()` resolves on success.
- *Happy path (banner):* Component mounts in `idle`; receives a "needs first-run download" signal; transitions to `consent`; shows countdown.
- *Happy path (banner):* In `consent`, after 5s the state advances to `downloading` and `startModelDownload` is called once.
- *Happy path (banner):* Receives a `state: "ready"` SSE event → enters `done` → auto-dismisses after 2s.
- *Edge case (banner):* User clicks "Cancel" during 5s window → enters `skipped`; `startModelDownload` NOT called.
- *Edge case (banner):* During the 5s `consent` countdown, settings change away from `local-gte` (e.g., user opens Settings and picks `openai`) → banner re-checks settings on countdown elapse and transitions to `idle` instead of `downloading`; no GTE download triggered.
- *Edge case (banner):* User clicks "Skip" after a failed download → enters `skipped` with the "Set up in Settings" CTA visible.
- *Error path (banner):* SSE `state: "error"` event → after 3 auto-retries, enters `failed`; retry button calls `startModelDownload` again.
- *Error path (banner):* Initial `client.settings()` fails (sidecar down) → component renders nothing (banner is a no-op without settings; the degraded-mode UI handles this elsewhere).
- *Happy path (RestartConfirmation):* User clicks "Restart" → modal opens → confirm → `restartSidecar` called → spinner → success → modal closes.
- *Error path (RestartConfirmation):* `restartSidecar` rejects → modal shows error message; user can dismiss.
- *Integration:* Settings shows a `Restart required` indicator after a settings PUT changes provider; clicking it opens the confirmation; confirming restarts the sidecar; indicator clears.

**Verification:**
- Component tests pass; manual verification: launch a fresh dev sidecar (delete `~/.cogios/search/`), open the app, see the banner; click cancel → see the persistent "skip" state; reopen Settings → see "Set up semantic search" affordance.

---

- [ ] **Unit 6: Settings → Features view + Providers section + provider editor slide-out**

**Goal:** Replace the existing `ModelManagerStatus` card in `SettingsLayout` with the new feature-vocabulary Features list + Providers section. Build the slide-out provider editor (idle/editing/validating/error/saved states) used from both inline-in-feature-row and Providers-section entry points.

**Requirements:** R2, R3, R4, R6, R9, R10

**Dependencies:** Unit 5.

**Files:**
- Create: `src/features/settings/components/FeaturesList.tsx`
- Create: `src/features/settings/components/FeaturesList.test.tsx`
- Create: `src/features/settings/components/FeatureRow.tsx` — single-feature row with toggle/badge, provider picker, status, restart-required indicator
- Create: `src/features/settings/components/FeatureRow.test.tsx`
- Create: `src/features/settings/components/ProvidersSection.tsx`
- Create: `src/features/settings/components/ProvidersSection.test.tsx`
- Create: `src/features/settings/components/ProviderEditor.tsx` — slide-out panel; manages all editor states
- Create: `src/features/settings/components/ProviderEditor.test.tsx`
- Modify: `src/features/settings/components/SettingsLayout.tsx` — replace `ModelManagerStatus` mount with `FeaturesList` + `ProvidersSection`. Leave `IndexingStatusCard` mount in place for now; Unit 7 relocates it into the Diagnostics sub-section as part of the same final layout move.
- Modify: `src/styles/app.css` — add new CSS for feature rows, provider editor slide-out, status badges, masked-key display
- Test: `src/features/settings/components/SettingsLayout.test.tsx` — extend if existing assertions about `ModelManagerStatus` need updating

**Approach:**
- `FeaturesList` reads `settings()` once on mount + on every settings change (passed in from `SettingsLayout`); renders one `FeatureRow` per feature in canonical order (`semantic-search`, `result-reranking`, `image-ocr`, `image-captioning` — same canonical order as the existing ROLE_ORDER pattern from the prior brainstorm).
- `FeatureRow` props: `feature: FeatureConfig`, `featureMeta` (display name, description, capability needed, mandatory flag, phase-2-disabled flag), `availableProviders: ProviderConfig[]` (filtered by capability), `onChange(partial)`. Renders:
  - Header row: feature name + `Required` badge OR enable toggle; description below
  - If enabled: provider picker dropdown (filtered list) + status indicator (`Ready` / `Restart required` / `Provider unavailable` / `Configuring`)
  - "Edit provider" button → opens `ProviderEditor` slide-out for the bound provider
  - For phase-2 features (`image-ocr`, `image-captioning`): toggle is rendered greyed out + tooltip "Available in next release"; no provider picker
- `ProvidersSection`: reads the same settings; renders one row per preset (`Object.values(PRESETS)` from a TS-side mirror of the sidecar preset table — see deferred questions for exact shipping mechanism; v1 hardcodes the TS mirror manually). Each row: provider name + type badge + configured-or-not status + Add/Edit/Remove actions.
- `ProviderEditor` props: `provider: ProviderConfig | null` (null = adding new), `preset: ProviderPreset`, `onSave(config)`, `onCancel()`, `onRemove()`. State machine:
  - `idle`: shows current config (masked key for cloud, download status for local)
  - `editing`: input field for API key (masked input); validation pings `/v1/models` on save
  - `validating`: spinner with "Validating..."
  - `error`: shows error text inline; user can fix and re-save
  - `saved`: collapses back to `idle` with a success indicator
- Masked key format: `<prefix>...XXXX` from preset (e.g. `sk-...x4kK`).
- "Restart required" indicator on each affected feature row when `settings.needsRestart === true`.

**Patterns to follow:**
- Existing `ModelManagerStatus.tsx` row layout + status badge styling
- Existing `LicenseAcceptanceModal.tsx` modal/form pattern for the inline API key entry
- Existing Settings CSS conventions in `src/styles/app.css` (`.settings-card`, `.settings-role-*`)

**Test scenarios:**
- *Happy path (FeatureRow, mandatory):* `semantic-search` row renders the `Required` badge in the toggle slot, with a provider picker showing the bound provider.
- *Happy path (FeatureRow, optional):* `result-reranking` row shows enable toggle in `Off` state; toggling on triggers `onChange({ enabled: true })`.
- *Happy path (FeatureRow, phase-2):* `image-ocr` row renders the disabled toggle with a tooltip "Available in next release"; clicking does nothing.
- *Happy path (provider picker):* For `semantic-search`, the dropdown shows `Local GTE` + `OpenAI` (cloud, configured) but NOT `Qwen` (no embedding capability in v1).
- *Happy path (ProviderEditor, idle → editing → saved):* Click Edit on OpenAI row → editor opens in `idle` showing masked key → click Edit → input visible → enter key → click Save → `validating` → `saved`.
- *Happy path (ProviderEditor, validation success):* Mocked `setProviderSecret` resolves; mocked `/v1/models` validation succeeds → editor enters `saved` state.
- *Edge case (ProviderEditor, validation failure):* Mocked validation returns 401 → editor enters `error` state with "Invalid API key" message; user can retry.
- *Edge case (ProviderEditor, masked key):* Configured key `sk-abc123...x4kK` displays as `sk-...x4kK` in idle state.
- *Edge case (ProviderEditor, remove):* Click Remove → confirmation prompt naming the bound features → on confirm, `deleteProviderSecret` called + settings updated to remove the provider config.
- *Happy path (ProvidersSection):* Renders one row per preset; configured providers show "Configured ✓"; unconfigured show "Add" button.
- *Happy path (ProvidersSection):* Add OpenAI flow: click Add → editor opens in `editing` state → enter key → save → row updates to `Configured`.
- *Edge case (ProvidersSection):* Removing a provider currently bound to a feature shows a confirmation listing affected features.
- *Integration (cross-component):* Adding OpenAI in ProvidersSection makes OpenAI appear in `semantic-search` provider picker without page refresh (settings re-fetch after PUT).
- *Integration (R3 — configure-once-available-everywhere):* After binding `semantic-search` to `openai` and saving, the `result-reranking` row's provider picker (when toggled on) shows OpenAI in the dropdown without re-prompting for an API key. This single test traces R3 across feature rows.
- *Integration (R4 — provider deletion safety):* In a real sidecar process, configure OpenAI for `semantic-search`, enqueue a small indexing job, then call `deleteProviderSecret("openai")` mid-flight. Sidecar must NOT crash; the in-flight job marked ERROR with a "key missing" message in the queue status; the next embed attempt also fails cleanly. After restart with no provider configured, settings show the feature as "Provider unavailable — pick another", and the sidecar runs in degraded mode without exception spam.
- *Integration (restart required):* After binding `semantic-search` to OpenAI, the feature row shows a "Restart required" pill; the inline `RestartRequiredBanner` from Unit 5 also appears.

**Verification:**
- Component tests pass; manual: launch dev app, open Settings, configure OpenAI, see provider available across features, restart sidecar, verify search uses OpenAI.

---

- [ ] **Unit 7: Diagnostics relocation + cloud egress consent gate + final cleanup**

**Goal:** Old `ModelManagerStatus` card is reachable but no longer the primary view; cloud egress consent gate prevents silent first-time data send; final wiring cleanup.

**Requirements:** R6 (vocab-first); brainstorm "Cloud egress consent gate" deferred-to-planning item (origin doc, "Deferred to planning" section) promoted into v1 scope here.

**Dependencies:** Unit 6.

**Files:**
- Modify: `src/features/settings/components/SettingsLayout.tsx` — add a small "Diagnostics" link/button in the Settings header that toggles a `Diagnostics` sub-section rendering `ModelManagerStatus` + the existing `IndexingStatusCard` for power-user visibility
- Create: `src/features/settings/components/CloudEgressConsentDialog.tsx` — one-shot per-provider consent
- Create: `src/features/settings/components/CloudEgressConsentDialog.test.tsx`
- Modify: `src/features/settings/components/FeatureRow.tsx` — when user picks a cloud provider for the first time (provider not in `cloud_consent_acked`), open the consent dialog before persisting; on accept, push provider to `cloud_consent_acked` via `updateSettings`
- Modify: `src/features/settings/components/ProviderEditor.tsx` — same gate when user adds a cloud provider via the Providers section's "Add" flow. The consent gate must wrap *every* path that newly binds a cloud provider, not just the FeatureRow inline picker, so a power user adding the provider first can't bypass it.
- Modify: `sidecar/search_sidecar/settings.py` — ensure `cloud_consent_acked: list[str] = []` is in the schema (declared in Unit 1, verified here)
- Test: cross-cutting — the consent dialog should appear once per provider, not per feature

**Approach:**
- Diagnostics is collapsed by default; clicking "Diagnostics" header button reveals it. No URL routing changes (Settings is still a modal).
- `CloudEgressConsentDialog` shows: "All indexed content used by features bound to {provider} will be sent to {provider}'s servers. Continue?". Provider name is from preset's `display_name`. Buttons: "Cancel" (no settings change) / "I understand, enable {provider}". On accept, the originating change (provider binding) is committed AND `cloud_consent_acked` is updated atomically in one settings PUT.
- The dialog is shown ONLY once per provider per workspace. Removing a provider does NOT clear the consent acknowledgment (re-adding doesn't re-prompt — by design; the user has previously consented to that vendor).

**Patterns to follow:**
- Existing modal pattern from `LicenseAcceptanceModal.tsx`
- Existing settings CSS

**Test scenarios:**
- *Happy path:* User picks OpenAI for `semantic-search`; OpenAI not in `cloud_consent_acked` → dialog appears → user accepts → settings PUT sets `features["semantic-search"].providerId = "openai"` AND `cloud_consent_acked = [..., "openai"]` in one call.
- *Happy path:* User picks OpenAI for `result-reranking` (a v1-reachable feature) when OpenAI already in `cloud_consent_acked` from the prior `semantic-search` binding → dialog does NOT appear; settings PUT immediate. (Originally written against `image-captioning`; that test moves to the Phase 2 plan since `image-captioning` has no v1 provider picker.)
- *Edge case:* User opens dialog and clicks Cancel → no settings change; provider picker reverts to previous selection.
- *Edge case:* User picks Local GTE (not a cloud provider) → dialog never shown.
- *Happy path (Diagnostics):* Settings header has a "Diagnostics" toggle; clicking reveals the old `ModelManagerStatus` card; clicking again hides it.
- *Edge case (Diagnostics):* On a fresh workspace with no prior model state, `ModelManagerStatus` still renders (uses existing `useSearchSubsystemStatus`).

**Verification:**
- Manual: configure OpenAI for the first time → consent dialog appears; configure for a second feature → no dialog. `~/.cogios/search/settings.json` shows `cloud_consent_acked: ["openai"]`.

## System-Wide Impact

- **Interaction graph:** Settings PUT → sidecar `settings.py:save_settings` → file write → sidecar `routes/settings.py` returns updated state with `needs_restart` flag. UI sees flag → prompts restart → Rust supervisor `restart()` → kill → wait for lock release → start → new sidecar boots with fresh settings → Dispatcher constructs the right embedder. Cross-cuts: existing model download SSE feed (workspace banner subscriber); existing IndexingRunner thread (uses the new embedder transparently after restart).
- **Error propagation:** Settings file write failure → 500 from sidecar → IPC error to Rust → error to UI. Cloud embedder runtime error (401, dim mismatch) → indexing job marked failed in the queue → existing queue-status surfaces it. Sidecar restart failure → supervisor `Failed` state → UI shows "Restart failed" with the supervisor's error string. Settings file corruption → fallback read may also fail → UI shows "Configuration unreadable; edit `~/.cogios/search/settings.json` manually" message.
- **State lifecycle risks:**
  - Settings PUT crashes mid-write — atomic `tmp + rename` mitigates partial-write corruption.
  - Provider deleted while in-flight indexing job uses old key — out-of-scope for v1 per brainstorm; documented in deferred-to-planning. Practical mitigation: API key is read lazily per embed call from keychain; once deleted, next embed surfaces a clear "key missing" error → job fails (existing behavior).
  - Concurrent settings PUT from two windows — file lock on `os.replace` is atomic; last write wins. Acceptable since Settings is a single window.
  - `boot_signature` calculated against an outdated set of "dispatcher-affecting fields" (e.g., a future field is added but the signature hasn't been updated) — silent. Mitigation: keep the signature inputs explicit and tested.
- **API surface parity:**
  - The existing `GET /models/status` endpoint is unchanged (used by the relocated `ModelManagerStatus` card in Diagnostics).
  - The existing model download SSE flow (`POST /models/download/{role}` → `data: {…}\n\n` events) is unchanged; the workspace banner subscribes to the same Tauri event.
  - The existing `LicenseAcceptanceModal` flow is untouched in this plan (Phase 2 generalizes it).
  - The new `GET/PUT /settings` HTTP routes are bearer-authed by the existing middleware; no new auth surface.
- **Integration coverage:** Cross-layer scenarios that mocks alone won't prove:
  1. Settings PUT → sidecar restart → Dispatcher reconstructs with the new embedder type.
  2. First-run banner cancellation → `cloud_consent_acked`/`first_run_skipped` persisted → next launch shows "Set up in Settings" instead of re-prompting.
  3. Provider removal in Providers section → keychain entry deleted → in-memory embedder fails on next embed call → indexing job marked failed in queue.
  Each of these needs at least one cross-layer integration test.
- **Unchanged invariants:**
  - Existing search behavior (FTS + hybrid retrieval) for users who don't visit Settings.
  - The `EMBEDDING_DIMENSION = 768` lock — this plan explicitly preserves it; cloud providers must respect it.
  - `LicenseAcceptanceModal` for HF token / Gemma TOS — untouched in this plan.
  - The role-tagged chunk schema (recently shipped) — untouched.
  - The existing IPC pattern (Tauri commands proxy sidecar HTTP) — extended, not replaced.
  - The single-sidecar-process invariant via `sidecar.lock` — preserved by the supervisor's restart() waiting for lock release.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The Local GTE manifest still has `<pinned>` placeholder commits (the user hit this earlier in the session); first-run download will 404. | Pre-requisite outside this plan: run `uv run python -m search_sidecar.scripts.pin_manifest embedding` before Phase 1 ships. Document this as a release-blocker in the operational notes. |
| Python `keyring` library backend differences across macOS / Linux / Windows. | Test in CI on each target platform (or at least macOS for v1 since that's the primary). Document the backend dependency (`keyring` uses macOS Keychain by default on darwin; Linux requires `keyrings.alt` or a Secret Service daemon; Windows uses Credential Manager built-in). |
| Supervisor `restart()` race with the OS-level `sidecar.lock` release. | Poll for lock release (up to 3s) between `kill()` and `start()`. Surface a clear error if lock is still held after timeout. |
| OpenAI silently changes `dimensions` parameter behavior (e.g., starts ignoring it for new model versions). | Hard-validate every embedding response against expected 768-dim. Fail loudly. The brainstorm's "wrong-shape data is a hard error" decision is enforced at the `OpenAICompatEmbedder` boundary, so any drift surfaces immediately. |
| Settings.json gets corrupted by an external editor while sidecar is running. | sidecar reloads settings only at boot; mid-run external edit is invisible until restart. Acceptable trade-off (matches the explicit "settings change requires restart" contract). |
| The `models/progress` SSE event was designed for local model downloads; the workspace banner reusing it for first-run UX may need a parallel feed once cloud-embedding-validation events exist. | v1 only ships local GTE auto-download via this feed; cloud validation uses a separate per-call IPC response, not SSE. So no overload. Re-evaluate if the validation flow ever needs streaming progress. |
| `boot_signature` field-list drift over time as new dispatcher-affecting fields are added. | Keep the inputs to `boot_signature` explicit and unit-tested. Add a unit test that asserts `boot_signature` of a default `SearchSettings()` against a fixed expected hash; any change to the inputs forces an explicit hash update. |
| The TS-side mirror of the provider preset table goes out of sync with the sidecar's `presets.py`. | v1 hardcodes both. v2 will likely fetch presets via a new `GET /providers/presets` endpoint. Test: an integration test that asserts the TS preset list matches the JSON returned by a real sidecar (caught at CI rather than runtime). |
| First-run banner state machine has multiple async event sources (settings response, models/progress SSE, user clicks); easy to introduce race conditions. | Use `useReducer` with explicit action types so every state transition is auditable; component test covers each transition. |
| `httpx` outbound calls to OpenAI carry `Authorization: Bearer <key>` — a misconfigured logger could leak the key into sidecar logs. | Configure the sidecar's `httpx.Client` with `event_hooks` or a custom transport that strips `Authorization` from log output; add a unit test that asserts a mocked 401 response is logged without the header value visible. |
| Provider deletion does NOT clear `cloud_consent_acked`; re-adding skips the consent dialog silently — security review flagged this as a privacy / trust gap. | v1 keeps the documented behavior (acknowledged in Unit 7) but adds a "Clear consent for this provider" checkbox to the Remove confirmation dialog so a user who explicitly wants re-consent can opt in. Default unchecked (preserves current behavior); checking it removes the consent ack. |
| `set_provider_secret`'s `provider_id` regex `[a-z][a-z0-9-]*` is permissive and doesn't allowlist against the known preset table — a future feature accepting external settings.json import could create orphan keychain entries. | Tighten the Rust command to validate `provider_id` against a hardcoded allowlist of known preset IDs; reject anything else. The allowlist mirrors `presets.py` v1 entries. |
| The TS preset table mirror has no automated CI check (the codebase has no CI infrastructure today: no `.github/workflows/`). | v1 ships with a hand-maintained mirror + a unit test that imports a JSON snapshot of the sidecar's preset list (committed at `sidecar/tests/fixtures/presets-v1.json`) and asserts the TS mirror matches. The snapshot is regenerated by a Python script (`scripts/dump_presets.py`); developers run it locally on preset changes. Real CI integration is a separate workstream. |
| Test infrastructure: Unit 2's "test sidecar against fixture HTTP server" implies `respx` or similar; `respx`/`pytest-httpserver` are not in `pyproject.toml`. | Add `respx>=0.21,<1.0` to dev dependencies in Unit 2's pyproject.toml change. Use it for the OpenAI client adapter tests. |
| `os.replace` on Windows can fail with `PermissionError` if another process has the file open (iCloud sync on macOS has the same hazard). | Wrap the settings write in retry-with-backoff (3 attempts, 100ms apart). Surface a clean error if all retries fail. Add a test scenario in Unit 1 covering the retry path. |
| macOS Keychain ACL prompts in dev (sidecar runs from system Python, not the bundled binary, so it doesn't share the app's signing identity). | Document in dev-onboarding: first time the sidecar reads a provider key, click "Always Allow" once. In production builds, the bundled sidecar binary ships under the same code-signing identity as the Tauri app, so the prompt does not trigger for shared bundle children. |

## Documentation / Operational Notes

- **Release-blocker prerequisite:** `pin_manifest.py` must be run for the embedding role (and any other role whose download is in v1 scope) before shipping. Add this to the release checklist.
- **Add to release notes:** "Settings now organizes search by feature (Semantic search / Result reranking / Image OCR / Image captioning) instead of model role. Existing local model state is preserved. Cloud provider support (OpenAI) is opt-in via Settings → Features → Semantic search."
- **Telemetry hook:** the workspace banner state machine emits transitions to the existing log pipeline (`@tauri-apps/plugin-log`) — no PII, just transition names. Useful for observing "how many users hit the Cancel button" once we have telemetry.
- **Rust-side cross-platform test:** the `keyring` library's behavior across platforms is the highest-risk infra dependency. Run the keyring smoke tests on at least macOS + Linux CI before shipping.
- **No DB migration needed:** settings are stored in a new file; no existing data to migrate. Existing lancedb / queue.db / model files are untouched.
- **Diagnostics relocation:** the old `Settings → Models` card is now reachable via a "Diagnostics" toggle. Once telemetry shows ≤5% of sessions open it, Phase 2 plan can remove it entirely.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-02-feature-oriented-settings-requirements.md](../brainstorms/2026-05-02-feature-oriented-settings-requirements.md)
- **Adjacent prior brainstorm:** [docs/brainstorms/2026-05-02-models-settings-row-display-requirements.md](../brainstorms/2026-05-02-models-settings-row-display-requirements.md) — solved the row-display problem under the old framing; the row-display work shipped in commit `6f2aa80` and its component (`ModelManagerStatus.tsx`) is what gets relocated to Diagnostics here.
- **Recent code in scope:**
  - `sidecar/search_sidecar/storage/lancedb_store.py` (768-dim lock)
  - `sidecar/search_sidecar/embeddings/__init__.py`, `embeddings/gte.py` (existing embedder factory)
  - `sidecar/search_sidecar/lifecycle.py` (sidecar startup ordering)
  - `sidecar/search_sidecar/scripts/pin_manifest.py` (manifest pinning helper, prerequisite)
  - `src-tauri/src/services/secure_storage.rs` (already-generic keychain wrapper)
  - `src-tauri/src/services/search/supervisor.rs` (start/kill, missing restart)
  - `src/features/settings/components/SettingsLayout.tsx` (current Settings entry point)
  - `src/features/settings/components/ModelManagerStatus.tsx` (relocated to Diagnostics)
  - `src/app/App.tsx` (banner mount point)
- **Related prior commits:**
  - `737691b` — brainstorm doc landing
  - `6f2aa80` — adjacent brainstorm (row display) shipped the `repo` field + canonical row order
  - `313acb6` — `pin_manifest.py` CLI
  - `fc4cfe4` — chunk-role schema (unrelated but shipped same session)
- **External references:** OpenAI embeddings API `dimensions` parameter (Matryoshka representation). Python `keyring` library docs.
