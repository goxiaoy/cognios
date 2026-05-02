---
title: Feature-oriented Settings with provider routing
type: requirements
status: ready-for-planning
date: 2026-05-02
revised: 2026-05-02 (post document-review; scope tightened, architectural blockers resolved)
scope: deep
---

# Feature-oriented Settings with provider routing

## Problem

Today's Settings → Models card asks users to think in the wrong vocabulary. It exposes four model "roles" (Embedding / Reranker / OCR / Captioner) and asks the user to manually download each one, accept licenses, and trust that the right model gets wired to the right place.

Most users don't think in terms of models. They think:

- "I want my screenshots to be searchable" (image OCR)
- "I want descriptions generated for my images" (image captioning)
- "I want better search results" (semantic + reranking)

Two consequences:

1. **Wrong cognitive level.** Users have to learn what an "embedding" is before they can turn search on.
2. **Hidden coupling between models and features.** A user who configures an OpenAI API key for one feature can't see that the same key would also serve other features. A user who downloads Gemma for image captioning doesn't realize it could also power a future chat feature.

Compounding both: the OCR and image-captioning extractor wiring (`paddleocr`, `llama-server`) is **not yet implemented** in the sidecar. The current `ImageProcessor` is constructed without extractors at [`sidecar/search_sidecar/index/dispatch.py:38`](sidecar/search_sidecar/index/dispatch.py#L38). Any settings UI we ship now must shape the conceptual model for those features even before they fully work.

> **Premise validation note (deferred to v1 ship):** This redesign rests on the assumption that "users prefer feature vocabulary over model vocabulary." We have no telemetry, support tickets, or interviews supporting this yet (the product has no public users). v1 ships the redesign as a bet; if signal post-launch contradicts it, we revisit.

## Conceptual model

Three layers, each independently configurable:

```
Providers ──── declare ──→ Capabilities ──── used by ──→ Features
(user configs)              (typed slots)                  (user enables)

OpenAI API key       →  embedding, vision              Semantic search ── uses [embedding]
Qwen API key         →  chat, vision                   Image captioning ── uses [vision]
Local GTE            →  embedding                      Image OCR ── uses [ocr]
Local GTE Reranker   →  reranking                      Result reranking ── uses [reranking]
Local Gemma          →  vision
Local paddleocr      →  ocr
```

A **feature** declares which capability it needs. The user binds each feature to a provider that offers that capability. The binding is stored as `{features: {<id>: {enabled, provider_id}}}` in settings — there is no separate Binding object.

This decoupling means:

- Configuring an OpenAI key once unlocks every cloud-capable feature.
- Downloading Gemma once serves both image captioning and (future) chat.
- Adding a provider in v2 (Anthropic, Ollama, custom OpenAI-compatible endpoint) does not require touching feature code — only declaring its capability set in the provider preset table.

## Goals

- Settings vocabulary is **features**, not models. Users navigate to the thing they want to do, not the thing under the hood.
- **Mandatory features** (semantic search) hide the on/off toggle and only let users pick a provider — search cannot accidentally be disabled.
- **First-run experience is "open the app and it works"**: local GTE auto-downloads on first launch (~75 MB) with a 5-second cancellable consent banner. After cancel or successful download, semantic search is live. No Settings visit required for the happy path.
- **Provider configuration is incremental**: a user who only wants local privacy never sees an API-key field; a user who configures an OpenAI key once gets it offered for every compatible feature without retyping.
- **Provider management has a real home**: a `Providers` section in Settings lists all configured + available providers for editing keys, removing providers, re-downloading local models. Always visible (the empty-state-hidden behavior was removed in this revision — see Decisions / D5).
- **Settings persist** so the app behaves the same across restarts.
- **Settings schema is forward-compatible** — adding new providers/capabilities is a one-line edit in the preset table; no migration. (Earlier "no migration ever, including for new feature classes" was reframed as forward-compatibility constraint, not a v1 driver of registry shape.)
- **Recovery paths exist.** A user who configures a broken provider can always reach Settings to fix it (Rust-side fallback read of settings.json supports degraded read-only mode if the sidecar fails to start).

## Non-goals (v1)

- **Chat assistant** as a feature OR as a `chat` capability declaration. Both deferred until the chat feature itself is in scope.
- **DeepSeek as a v1 provider.** It only exposes chat (no embedding/vision/reranking), and chat is OOS in v1.
- **Qwen as an embedding provider.** Qwen v3 embedding is 1024-dim, not reducible to 768; v1 schema is locked at 768-dim. Qwen stays as a vision provider in phase 2.
- **Custom local models** beyond the bundled defaults.
- **Provider failover** or fallback chains (one provider per feature; failure is surfaced not silently rerouted).
- **Per-document provider routing.**
- **Cost / token tracking, quotas.**
- **Setup wizard** as the primary first-run UI. The 5-second cancellable banner serves the consent gesture.
- **In-process embedder/extractor hot-swap.** Provider changes that affect indexing wiring require a sidecar restart; UI surfaces this with a one-click restart action.
- **Migration of existing settings** — there are none today.

## Decisions

### D1 — Decoupled architecture: Providers + Capabilities + Features

User picked this over a 1:1 feature-to-model mapping after observing that Gemma serves both captioning and (future) chat, and an OpenAI key serves embedding + vision. Capability routing is a real architectural commitment. v1 declares only the capabilities that have a v1 consumer — `embedding`, `reranking`, `vision`, `ocr`. The `chat` capability is added when the chat feature is in scope.

### D2 — Cloud providers in v1: OpenAI, Qwen (no DeepSeek)

OpenAI uses the standard OpenAI HTTP protocol. Qwen DashScope's compatible-mode endpoint covers embedding/chat/vision via `/v1/...` paths but **not reranking** (its reranking API uses a non-OpenAI shape; v1 does not ship Qwen reranking). DeepSeek is dropped from v1 because chat is OOS — it offered no usable v1 capability.

Initial provider × capability matrix (v1 only — capabilities/providers without v1 consumers excluded):

| Provider | embedding (768) | reranking | vision | ocr |
|----------|:--------------:|:---------:|:------:|:---:|
| Local GTE | ✓ | | | |
| Local GTE Reranker | | ✓ | | |
| Local Gemma (via llama-server) | | | ✓ | |
| Local paddleocr | | | | ✓ |
| OpenAI | ✓ (`dimensions=768`) | | ✓ | |
| Qwen DashScope | | | ✓ | |

### D3 — Semantic search is mandatory; embedding constrained to 768-dim providers

Embedding cannot be disabled. The "Semantic search" row shows only a provider picker (default: Local GTE), no on/off toggle. **Visual treatment for "mandatory" status: the toggle slot is replaced by a small `Required` badge** (so users don't think the toggle is broken).

The lancedb chunk schema is locked at 768-dim ([`lancedb_store.py:53`](sidecar/search_sidecar/storage/lancedb_store.py#L53)). v1 only ships embedding providers that can produce 768-dim vectors:

- Local GTE → native 768
- OpenAI `text-embedding-3-small` → 1536 native, reducible to 768 via `dimensions` parameter (Matryoshka representation)
- Qwen embedding → native dimensions 1024/1536, no reduction parameter → not in v1 embedding matrix

If a future provider needs a different dimension, the schema must change (multi-dimension support is post-v1). The plan must implement the `dimensions=768` request parameter in the OpenAI client adapter and validate response shape; a wrong-dim response is a hard error, not silently stored.

### D4 — First-run: F2-with-consent (auto-download, but cancellable)

On first launch, a workspace-level banner appears with text:

```
Setting up local search engine (75 MB download from huggingface.co)
[Cancel] starting in 5 seconds...
```

After 5 seconds without cancel, the download starts. Banner updates to `Downloading... 32%`. On completion: `✓ Done` and self-dismisses after 2 seconds. On failure (network, disk, etc.): `✗ Failed — [Retry] [Skip and use basic search]`. After 3 auto-retries, retry becomes manual.

If the user clicks **Cancel** during the 5-second window, or **Skip** after a failure: sidecar runs in FTS-only mode (StubEmbedder); a persistent banner says `Semantic search not configured — [Set up in Settings]`. The user can resume setup from Settings at any time.

This preserves the "open and it works" UX while giving users on metered connections / corporate networks an explicit out — addressing the privacy-positioning concern raised in review.

### D5 — Settings layout: L2a (features-first; Providers section always visible)

The primary Settings view is a **Features** list. Each row carries:

- The feature name + a one-line user-vocabulary description
- For optional features: an enable toggle. For mandatory features: a `Required` badge in the toggle slot.
- A provider picker (dropdown of providers that offer the required capability)
- For cloud providers: inline "API key: configured ✓ [Edit]" or an inline "Add API key" prompt if the picked provider has none
- For local providers that need download: an inline progress bar or "[Download]" button
- "Restart required" notice if the chosen provider differs from what the running sidecar has wired (since v1 has no hot-swap)

A **Providers** section is always visible below the Features list. It lists every provider preset (configured or not) with [Add] / [Edit] / [Remove] / [Re-download] actions. Earlier "auto-appears once configured" rule was dropped after review pointed out that Local GTE auto-downloads on first launch, making the section visible immediately anyway.

Both inline-in-feature and Providers-section open the same provider editor (a slide-out panel adjacent to the row, not a modal — keeps Settings context visible). Editor states:

- **Idle** — shows current config (key reference, download status)
- **Editing** — input field with masked key, validation on save
- **Validating** — spinner while pinging `/v1/models` (or per-provider validation endpoint)
- **Error** — invalid key / unreachable / 401 → inline error message
- **Saved** — collapses back to idle with success toast

API key masking format: `sk-...XXXX` (last 4 characters) for OpenAI-style; vendor prefix preserved if present. Truncation at 4 chars is enough to distinguish two keys, short enough not to leak the secret.

### D6 — Settings persistence: sidecar-owned JSON file with Rust-side fallback read

Settings live at `~/.cogios/search/settings.json`, written and read by the sidecar. File mode is **`0600`** (matches `sidecar.runtime` / `sidecar.lock` convention; default umask 0022 would leave it world-readable, which is unacceptable since it lists configured providers).

Frontend reads via a new IPC chain:
- Sidecar route: `GET /settings`, `PUT /settings`
- Rust Tauri command: `get_search_settings`, `update_search_settings` (proxies the sidecar HTTP calls; bears the bearer token from `sidecar.runtime`)
- TS `SearchClient` method: `settings()`, `updateSettings(partial)`

**Rust-side fallback read** for degraded mode: if the sidecar fails to start (lock contention, port issue, broken provider config crashing init), Rust reads `settings.json` directly and surfaces a read-only Settings view labeled `Sidecar unavailable — view-only`. The user can see what's configured and manually edit the file path if needed; full editing requires sidecar back up. This addresses the "settings unreachable when sidecar broken" review finding.

### D7 — API keys via Python `keyring` in the sidecar

API keys do **not** live in `settings.json`. They go into the OS keychain. Both Rust (via existing `src-tauri/src/services/secure_storage.rs`) and Python sidecar (via the `keyring` PyPI package, new dependency) read from the same OS keychain using a shared service name `cogios-search` and account names `provider:<provider_id>` (e.g. `provider:openai`).

- **Write path**: User enters API key in UI → frontend calls Rust IPC `set_provider_secret(provider_id, key)` → Rust writes to keychain → frontend calls `PUT /settings` with the new provider config (no key in payload, only `{"api_key_ref": "keychain://cogios-search/provider:openai"}`).
- **Read path**: Sidecar's cloud Embedder, on first instantiation per provider, calls `keyring.get_password("cogios-search", "provider:openai")` and caches the resolved key in memory.
- **Delete path**: User removes provider in UI → frontend calls Rust IPC `delete_provider_secret(provider_id)` → keychain entry removed → `PUT /settings` removes the provider from settings → sidecar restart purges in-memory cache.

`settings.json` only stores references — no plaintext secrets. The reference format is `keychain://cogios-search/<account_name>` (informational; the sidecar resolves via the constant service+account, not by parsing the URL).

### D8 — Provider swap requires sidecar restart in v1

Changing the bound provider for any feature affects the dispatcher's wiring. v1 does NOT support hot-swap. The UI surfaces this honestly:

- Changing a provider in the dropdown immediately persists the new selection.
- Settings shows a `Restart required to apply changes` banner with a `[Restart sidecar]` button.
- Clicking restart triggers Rust to gracefully stop + restart the sidecar process; the Settings UI shows a brief "Reconnecting..." state.
- If the user changes the embedding provider AND the new provider has a different effective dimension config (only the OpenAI 3-small case in v1, which we constrain to 768): warning + confirmation prompt about re-indexing. Triggers a full table rebuild on next sidecar boot, not the existing `reembed_stale_chunks` sweep (which only handles same-dimension swaps).

Hot-swap is deferred to v2.

## Feature catalog (v1)

| Feature | Capability needed | Default | Mandatory? | Notes |
|---------|------------------|---------|------------|-------|
| Semantic search | embedding | On (Local GTE) | **yes** | Provider configurable; on/off hidden behind `Required` badge |
| Result reranking | reranking | Off | no | Quality bump after semantic search; one extra small model |
| Image OCR | ocr | Off | no | Phase-2 extractor work needed before this actually produces chunks |
| Image captioning | vision | Off | no | Phase-2 extractor work needed before this actually produces chunks |

## Provider catalog (v1)

| Provider | Type | Auth | License gate | Default models per capability |
|----------|------|------|--------------|------------------------------|
| Local GTE | local download | none | none | embedding: `gte-multilingual-base` (int8 ONNX, 768-dim) |
| Local GTE Reranker | local download | none | none | reranking: `gte-multilingual-reranker-base` |
| Local paddleocr | local download | none | none | ocr: PP-OCRv4 mobile (det + rec + cls) |
| Local Gemma | local download | HF token | Gemma TOS (HF) | vision: `gemma-3n-E2B-it-Q4_K_M.gguf` + mmproj |
| OpenAI | cloud | API key | none | embedding: `text-embedding-3-small` (with `dimensions=768`), vision: `gpt-4o-mini` |
| Qwen DashScope | cloud | API key | none | vision: `qwen-vl-plus` |

## Phased scope (revised — was 3 phases, now 2)

The full vision is one cohesive feature; shipping is staged so each phase is independently useful.

### Phase 1 — Settings persistence + provider routing + working features

Combines what was Phase 1 + Phase 2 in the original draft. Reviewer consensus said the original Phase 1 was infrastructure-only ceremony (no user-actionable UI). Combined phase delivers the first real user action: switching semantic search to OpenAI.

**Sidecar:**
- New routes `GET /settings`, `PUT /settings`
- New `~/.cogios/search/settings.json` (mode 0600) with v1 schema
- Provider registry with capability declarations (only v1 capabilities + providers)
- Cloud `Embedder` implementation that calls OpenAI `/v1/embeddings` with `dimensions=768`
- Python `keyring` dependency added; sidecar reads keys via the shared `cogios-search` service
- Restart-required mechanism: settings change triggers a "needs restart" flag readable via `GET /settings`

**Network protocol:**
- OpenAI-compatible client adapter for embedding + vision endpoints (NOT reranking — out of v1)
- Per-provider preset table declaring capabilities + default model per capability + base URL + validation endpoint

**Rust + frontend bridge:**
- Tauri commands: `get_search_settings`, `update_search_settings`, `restart_sidecar`, `set_provider_secret`, `get_provider_secret_present`, `delete_provider_secret`
- Rust-side fallback read of `settings.json` for degraded view when sidecar is down
- TS `SearchClient.settings()` / `updateSettings()` / `restartSidecar()`

**Frontend UI:**
- New Settings → Features view (replaces old Models card; old card kept as `Advanced → Diagnostics` view)
- Per-feature row: enable toggle (or `Required` badge), provider picker, inline API key entry, validation states, "Restart required" banner
- Providers section (always visible), provider editor slide-out panel
- Workspace-level first-run download banner with cancel + skip + retry
- App-level component (`AppShell` mount) hosting the banner — subscribes to `models/progress` SSE

**End-of-phase ship value:**
1. New users get auto-download with consent.
2. Users can switch semantic search from local to OpenAI cloud.
3. Users can configure providers via UI; keys land safely in keychain.
4. Image OCR / Image captioning rows visible but disabled with "available in next release" hint.
5. Existing search functionality unchanged for users who don't visit Settings.

### Phase 2 — Optional feature extractors

- paddleocr extractor wiring → Image OCR feature becomes real
- llama-server supervisor + Gemma loader → Image captioning with Local Gemma
- Cloud vision routing → Image captioning with OpenAI / Qwen
- License flow integration: Local Gemma config triggers Gemma TOS UI inline in the provider editor (refactor `LicenseAcceptanceModal` to accept role-specific `licenseUrl` / `repoUrl` / `copy` props)

**End-of-phase ship value:** Every v1 feature is real.

## User-visible behavior

| Scenario | What happens |
|---|---|
| Brand-new user opens app | Banner appears: "Setting up local search engine (75 MB)... [Cancel] starting in 5s". 5s pass without cancel → download starts. Banner updates to %. On done: ✓ Done, dismisses after 2s. Search uses local GTE. |
| User clicks Cancel during 5-second window | Banner shows "Semantic search not configured — [Set up in Settings]". App runs FTS-only (BM25 search still works). |
| First-run download fails 3 times | Banner shows "✗ Setup failed — [Retry] [Skip and use basic search]". Persists until user picks one. |
| User opens Settings → Features for the first time | Sees Features list. Semantic search shows `Required` + "Local GTE — Ready". Optional features show toggles, all off. Providers section below shows Local GTE + unconfigured cloud presets [OpenAI, Qwen]. |
| User toggles "Image captioning" → On (after phase 2) | Row expands. Provider dropdown lists [Local Gemma (3 GB download), OpenAI Vision, Qwen Vision]. Inline prompt: "Pick a provider." |
| User picks "OpenAI Vision" with no key configured | Inline form: "OpenAI API key" input + "Save & enable". On save: validation pings `/v1/models` (provider's listed validation endpoint); on success, key → Rust IPC → keychain; settings PUT; "Restart required" banner appears. |
| User clicks "[Restart sidecar]" | Brief "Reconnecting..." (~2s). Settings UI re-fetches state. Feature is now active. |
| User picks "Local Gemma" | License + HF token UI appears inline in provider editor (Gemma TOS link, "I have accepted the Gemma Terms of Use at huggingface.co" checkbox + token input). On accept, download starts (3 GB, progress in panel). |
| User has OpenAI configured + enables a second cloud feature | Second feature's dropdown shows "OpenAI" already as a configured option. Picking it requires no extra config. |
| User switches Semantic search from Local GTE to OpenAI | Confirmation: "Switching providers will re-index your workspace (~N chunks, ~M minutes) on next start. Continue?" On confirm, "Restart required" banner. Restart triggers full table rebuild + re-index from source documents. |
| User goes to Providers section, removes OpenAI | Confirmation: "OpenAI is currently used by {Semantic search, Image captioning}. These features will revert to defaults or require picking another provider." On confirm, key purged from keychain; settings updated; "Restart required" banner. |
| User edits OpenAI key (rotated) | Either inline from any feature row using OpenAI, or from Providers section. Same slide-out editor. New key validated against `/v1/models`; on success persisted; "Restart required" banner. |
| Sidecar can't start (broken config) | Settings UI loads in degraded mode via Rust-side fallback read. Banner: "Sidecar unavailable — settings shown read-only. Edit `~/.cogios/search/settings.json` to recover, then click [Try again]". |
| Sidecar restart | Settings reload from `settings.json`. Dispatcher rebuilds with the right extractors per the bound providers. |
| Cloud provider call fails mid-indexing (rate limit, network) | Job marked failed in queue; surfaced in queue status view (existing). User sees error count; no silent reroute. |

## Success criteria

1. A new user opens the app; within ~30 seconds (covering download time on a 10 Mbps connection — reviewer flagged the original "10s typical" as unrealistic for 75 MB) semantic search is fully functional with zero Settings interaction. Cancel-then-resume from Settings is also tested.
2. **Phase 1:** Toggling semantic search from Local GTE to OpenAI, entering an API key, restarting sidecar, and seeing search results from the new provider takes ≤ 5 user actions in Settings.
3. **Phase 2:** Toggling Image captioning on, picking a provider, entering credentials, and seeing a captioned image in search takes ≤ 4 user actions.
4. After configuring OpenAI for any feature, every other compatible feature offers OpenAI as a provider with no re-entry of the key.
5. Removing a provider from the Providers section reliably disables all features bound to it without crashing the sidecar or producing inconsistent state.
6. Restarting the app preserves every setting: enabled/disabled state, bound providers, downloaded local models, configured API keys.
7. The Settings vocabulary is feature-first; the words "embedding", "reranker", "ONNX", "GGUF" do not appear in the primary Features view (they may appear in the Providers section's advanced details).
8. Settings.json is written with file mode 0600 and contains no plaintext secrets (verifiable by inspection on disk).
9. When sidecar fails to start, Settings UI loads in read-only fallback mode within 3 seconds and surfaces a clear recovery message.

## Deferred to planning

Implementation-time questions that don't change the product shape but need answers:

- **Settings schema concrete shape.** Strawman: `{"version": 1, "providers": {<id>: {type, capabilities, default_model_per_capability, api_key_ref?, base_url?, ...}}, "features": {<id>: {enabled, provider_id?}}}`. Validate at load time; reject unknown fields gracefully; refuse to load future schema versions (require app upgrade).
- **API key validation per provider.** Plan needs a per-provider validation endpoint table — OpenAI: `/v1/models`, Qwen DashScope: TBD. The ping leaks key existence to the cloud provider; acceptable since user just typed it.
- **Cloud egress consent gate.** First time a user picks a cloud provider for any feature, show a one-shot dialog: "All indexed content will be sent to <Provider> when this feature is active. Continue?". Per-provider, not per-feature. Persisted in settings as `cloud_consent_acked: ["openai"]`.
- **Provider deletion in-flight job handling.** When user removes provider, in-flight indexing jobs using it must be canceled cleanly, not allowed to complete with stale credentials. Plan needs to specify the cancel signal flow.
- **First-run download cancellation timing.** The 5-second pre-download window UX is specified above but the implementation needs to be on a real timer the user can interrupt without race conditions.
- **Old Settings → Models card placement.** Plan should specify "Advanced → Diagnostics" or equivalent section name; current ModelManagerStatus.tsx becomes that diagnostics view rather than being deleted (review noted no-users-in-the-field but it's still useful as debug surface).
- **Workspace-banner component.** Lives in `AppShell` between titlebar and sidebar. Subscribes to existing `models/progress` SSE. No persistence across app restarts (banner restarts in same state on relaunch if download not done).
- **`LicenseAcceptanceModal` refactor for inline use.** Phase 2 generalizes it: `licenseUrl`, `repoUrl`, copy template, and a stronger acknowledgment ("I have accepted the Gemma Terms of Use at huggingface.co" checkbox, not just "Accept" button).
- **Cloud response shape validation.** Embedding responses must be checked for: (a) correct vector dimension (768), (b) correct array length matching input batch size, (c) numeric type. Wrong shape = hard error, not silent store. Mitigates the "malicious base URL" scenario.
- **Audit log.** Append-only log file in `~/.cogios/search/settings-audit.log` (mode 0600), one line per provider add/edit/remove with timestamp. Cheap, helps "did I add this?" forensics.
- **Cancellation semantics for downloads.** Disabling a feature mid-download cancels via existing supervisor / SSE `cancel` event (verify supports this; if not, accept restart to cancel).
- **Per-feature "Restart required" granularity.** A change to `Image OCR`'s provider requires sidecar restart only if extractors are wired differently. Editing API key on a cloud provider that doesn't change wiring may not. Plan should specify which changes need restart.
- **`keyring` library on each platform.** Python `keyring` uses macOS Keychain on macOS, Secret Service on Linux, Credential Manager on Windows. Verify all three work with the same `cogios-search` service name as Rust uses, and that each Tauri-bundled Python sidecar has the right backend installed.
- **Dimension-mismatch hard error for OpenAI.** If OpenAI ever returns non-768 vectors despite the `dimensions=768` request, fail loudly. The reembed sweep does NOT silently skip wrong-dim batches in v1.

## Adjacent / out of scope

- **Provider failover** (if cloud rate-limits, fall back to local). Surface as error.
- **Cost / token-usage tracking.** Worth doing once chat assistant ships.
- **Multi-binding** (one feature uses several providers).
- **Anthropic / Gemini / other non-OpenAI-compatible providers.** Add later.
- **Custom OpenAI-compatible base URL.** Users can pick "OpenAI" and override base URL — implicit in the OpenAI-compatible client (planning detail). Cloud egress consent must include the custom base URL.
- **Workspace-scoped settings.** All settings app-global today.
- **In-process embedder hot-swap.** Deferred to v2.
- **Cloud sync of settings across devices.** Considered intentionally — sidecar-owned local file blocks cloud sync. v2 design will need to either move settings to OS app-data dir or build sync separately.
- **Multi-dimension embedding schema** (per-workspace dimension). v1 locked at 768.

## References

- Adjacent brainstorm: [`docs/brainstorms/2026-05-02-models-settings-row-display-requirements.md`](2026-05-02-models-settings-row-display-requirements.md)
- Existing model lifecycle: [`sidecar/search_sidecar/models/manager.py`](../../sidecar/search_sidecar/models/manager.py) — `ModelManager.download()` SSE pattern reused; class itself does not extend to cloud (cloud providers are configuration, not downloadable artifacts).
- Existing manifest: [`sidecar/search_sidecar/models/manifest.py`](../../sidecar/search_sidecar/models/manifest.py) — local providers' specs.
- Manifest pinning helper: [`sidecar/search_sidecar/scripts/pin_manifest.py`](../../sidecar/search_sidecar/scripts/pin_manifest.py) — required for any local provider to actually download in production builds.
- Existing Rust keychain wrapper: [`src-tauri/src/services/secure_storage.rs`](../../src-tauri/src/services/secure_storage.rs) — phase 1 extends with generic `set/get/delete_provider_secret(provider_id)` commands beyond the current HF-token-specific surface.
- Existing keychain commands (HF-only): [`src-tauri/src/commands/secrets.rs`](../../src-tauri/src/commands/secrets.rs) — phase 1 adds provider-parameterized commands.
- Current dispatcher (no extractors wired): [`sidecar/search_sidecar/index/dispatch.py:38`](../../sidecar/search_sidecar/index/dispatch.py#L38).
- Existing license modal pattern: [`src/features/settings/components/LicenseAcceptanceModal.tsx`](../../src/features/settings/components/LicenseAcceptanceModal.tsx) — phase 2 generalizes with role-specific props.
- Settings card today: [`src/features/settings/components/ModelManagerStatus.tsx`](../../src/features/settings/components/ModelManagerStatus.tsx) — becomes the Advanced → Diagnostics view in phase 1.
- Existing download progress hook: [`src/features/settings/hooks/useModelDownloadProgress.ts`](../../src/features/settings/hooks/useModelDownloadProgress.ts) — lifted to App-level mount in phase 1.
- Embedder protocol: [`sidecar/search_sidecar/index/embedder.py`](../../sidecar/search_sidecar/index/embedder.py) — sync; cloud Embedder uses sync `httpx` from worker thread.
- Re-embed sweep: [`sidecar/search_sidecar/embeddings/reembed.py`](../../sidecar/search_sidecar/embeddings/reembed.py) — only handles same-dimension stub→real swaps; provider swap requires full table rebuild (see D8).
- Lifecycle / sidecar startup: [`sidecar/search_sidecar/lifecycle.py`](../../sidecar/search_sidecar/lifecycle.py) — Dispatcher constructed once at boot; restart required for re-wiring.
- Existing settings dir hardening: [`sidecar/search_sidecar/lifecycle.py:56`](../../sidecar/search_sidecar/lifecycle.py#L56) — parent dir mode 0700; new `settings.json` must add file-level 0600 (using `os.open(path, flags, 0o600)` like `runtime_file.py` does).

## Document review trail

This brainstorm went through `/ce:document-review` with 7 personas (coherence, feasibility, product-lens, design-lens, security-lens, scope-guardian, adversarial). Top findings that drove this revision:

- **Feasibility F-01 / Adversarial F1 (BLOCKER):** Embedding dimension lock-in unaddressed. Resolved in D3 by constraining v1 cloud providers to 768-output-capable.
- **Security F1 / Feasibility F-04 (BLOCKER):** No path from sidecar to keychain. Resolved in D7 by adding Python `keyring` to sidecar.
- **Feasibility F-02 / F-07 (BLOCKER):** No runtime dispatcher rebuild. Resolved in D8 by requiring sidecar restart on provider change.
- **Adversarial F2 (HIGH):** OpenAI-compatible adapter doesn't cover Qwen reranking. Resolved by dropping Qwen reranking from v1.
- **Coherence F-001:** OpenAI listed as reranking provider in user-flow but matrix says no. Auto-fixed.
- **Scope F1, F2, F6 / Product F-02, F-06 (3-reviewer consensus):** Phase 1 ceremony, scope overbuilt for v1 consumers, DeepSeek powers no v1 feature. Resolved by collapsing Phase 1+2 and dropping DeepSeek + chat capability + Qwen vision/reranking from v1.
- **Adversarial F3 (HIGH):** Mandatory + cloud paradox no escape. Resolved by adding D6 fallback read + restart UI surfacing health.
- **Adversarial F8 / Product F-04 (HIGH):** Auto-download privacy contradiction + no failure path. Resolved by D4 cancel-then-skip-then-retry banner.
- **Security F2:** settings.json file permissions unspecified. Resolved by D6 explicit 0600.
- **Security F3:** Cloud egress disclosure inadequate. Resolved by deferred cloud-consent gate.
- **Design-lens (interaction states 2/10):** Many gaps. Partially resolved by D5 explicit editor states + D3 mandatory visual treatment + D4 banner failure UX. Remaining gaps deferred to planning (per-error-state row appearance, focus management, keyboard nav).
- **Adversarial F7 / Product F-06 / Scope F6:** Phase 1 was ceremony. Resolved by collapsing into a single substantial phase.
- **Scope F8 / Adversarial F6:** Various smaller cleanups (chat row removed, Providers section always-visible).
