---
title: "feat: Persist local observability metrics"
type: feat
status: completed
date: 2026-05-11
origin: docs/plans/2026-05-10-003-feat-home-statistics-plan.md
---

# feat: Persist local observability metrics

## Summary

Persist Home observability data in a privacy-safe sidecar SQLite database so 7/30 day views can show token usage and latency trends across sidecar restarts, not only the current process lifetime. Python remains the recorder and query owner because search, indexing, chat, OCR, and model-download work already execute there. Rust/Tauri and React continue to treat observability as a typed sidecar summary.

## Problem Frame

The Home statistics dashboard currently has useful UI and a sidecar summary route, but `token_usage` and latency percentiles are process-local rolling memory. `recent_indexed_nodes` is durable because it is derived from `queue.db`, while token usage, search latency, indexing latency, OCR enhancement latency, and model-download latency disappear on restart and cannot support meaningful 7/30 day trends.

The goal is local operational observability, not telemetry export or analytics collection. The design must preserve CogniOS's trust boundary: store only aggregate metadata such as timestamps, metric names, durations, counts, provider IDs, model IDs, and success/failure flags. Do not store prompts, queries, source text, file paths, node names, or retrieved context.

## Requirements

- R1. Persist privacy-safe observability samples in sidecar-owned SQLite storage under the existing search storage directory.
- R2. Keep Python sidecar as the only writer for v1 observability metrics.
- R3. Preserve the existing `ObservabilityStore()` in-memory test path while adding a SQLite-backed `open_observability_store(...)` path for lifecycle.
- R4. Support `recent_days=7|30` summaries for token usage and latency, not only index counts.
- R5. Return latency trend buckets suitable for Home P90/P99 charts.
- R6. Keep existing Home fields backward-compatible: `recent_indexed_nodes`, `latency`, and `token_usage` remain present.
- R7. Add tests that prove token usage and latency survive reopening the observability database.
- R8. Do not add a third-party metrics framework or charting dependency.

## Scope Boundaries

- No OpenTelemetry Collector, Prometheus server, or external export in this iteration.
- No cloud sync, billing, quota enforcement, or cost forecasting.
- No prompt/query/source-content/path persistence.
- No Rust-side metric writes yet; sidecar startup/IPC metrics can be added later if needed.
- No exact long-term percentile rollup beyond the retained raw samples; v1 can compute P90/P99 from retained local samples.

## Existing Patterns To Follow

- `sidecar/search_sidecar/index/queue.py` owns SQLite connection setup, WAL pragmas, Python-side locking, and corruption recovery patterns.
- `sidecar/search_sidecar/index/migrations.py` demonstrates versioned `PRAGMA user_version` migrations.
- `sidecar/search_sidecar/lifecycle.py` creates `queue.db` under `search_dir`; persistent observability should live alongside it as `observability.db`.
- `sidecar/search_sidecar/observability.py` already defines duration summaries, token normalization, and privacy constraints.
- `sidecar/search_sidecar/routes/observability.py` already validates `recent_days=7|30` and combines queue-backed recent indexing with observability summary data.
- `src/lib/contracts/search.ts` and `src-tauri/src/services/search/client.rs` already mirror the sidecar observability payload.

## Key Technical Decisions

- **Use a sidecar SQLite DB, not the queue DB.** Observability data has different retention and schema evolution from indexing jobs; separate `observability.db` avoids coupling operational metrics to queue migrations.
- **Record events/samples, not raw payloads.** A compact sample table is enough for v1: timestamp, kind, ok, duration, provider, model, token counts. This keeps the model generic without introducing a full metrics platform.
- **Compute exact window percentiles from retained samples.** For local 7/30 day windows, retained raw samples are simpler and more accurate than approximating from rollups. Histogram rollups can be added if the database grows too large.
- **Use daily token aggregation at query time first.** Token usage data volume is low; summing retained rows by provider/model for 7/30 days is simpler than maintaining rollups during writes. A rollup table remains a future optimization.
- **Keep index counts queue-backed.** Indexed node counts already exist durably in `queue.db`; duplicating them into observability risks drift.
- **Extend the summary contract additively.** Add `latency_trends` to the sidecar/Rust/TS contract while keeping current `latency` fields for existing UI.

## Data Model

### `observability_samples`

Fields:
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `occurred_at TEXT NOT NULL` as UTC ISO 8601
- `kind TEXT NOT NULL` with values such as `search`, `indexing`, `enhancement`, `model_download`
- `ok INTEGER NOT NULL DEFAULT 1`
- `duration_ms INTEGER`
- `provider_id TEXT`
- `model TEXT`
- `prompt_tokens INTEGER NOT NULL DEFAULT 0`
- `completion_tokens INTEGER NOT NULL DEFAULT 0`
- `total_tokens INTEGER NOT NULL DEFAULT 0`

Indexes:
- `(kind, occurred_at)`
- `(provider_id, model, occurred_at)`
- `(occurred_at)`

Retention:
- Delete samples older than 90 days during open and opportunistically after writes.
- This retention is local-only and can be made configurable later.

## Implementation Units

### U1: SQLite-backed observability store

**Goal:** Upgrade `ObservabilityStore` so it can persist samples while retaining the current in-memory mode for lightweight tests.

**Files:**
- Modify: `sidecar/search_sidecar/observability.py`
- Test: `sidecar/tests/test_observability.py`

**Approach:**
- Add an optional SQLite connection/path to `ObservabilityStore`.
- Add `open_observability_store(path: Path) -> ObservabilityStore` that applies WAL pragmas, quick_check, schema migration, corruption recovery, and retention.
- Add `observability_samples` schema creation with indexes.
- Make `record_duration(...)` insert duration samples when SQLite is enabled, while still appending to bounded memory for immediate latest/process fallback.
- Make `record_usage(...)` insert token samples when SQLite is enabled, while preserving current in-memory aggregation behavior.
- Make `summary(recent_days=...)` query SQLite rows inside the requested window when available; fall back to in-memory behavior when not.
- Keep percentile calculations in Python.

**Test Scenarios:**
- Empty SQLite-backed store returns valid empty latency and token usage sections.
- Duration samples recorded before closing are visible after reopening the database.
- Token usage recorded before closing is aggregated by provider/model after reopening.
- Old samples outside the requested 7-day window do not affect 7-day token totals or latency percentiles.
- Invalid or missing provider/model/usage still records nothing sensitive and does not fail.

### U2: Lifecycle wiring and summary windows

**Goal:** Use the persistent store in the real sidecar and make summary windows apply consistently.

**Files:**
- Modify: `sidecar/search_sidecar/lifecycle.py`
- Modify: `sidecar/search_sidecar/routes/observability.py`
- Test: `sidecar/tests/test_observability.py`

**Approach:**
- Replace lifecycle's `ObservabilityStore()` with `open_observability_store(search_dir / "observability.db")`.
- Pass `recent_days` into `ObservabilityStore.summary(...)` so token usage and latency use the same 7/30 day window as index counts.
- Keep `build_app(...)` defaulting to `ObservabilityStore()` for existing unit tests.

**Test Scenarios:**
- `/observability/summary?recent_days=7` returns 7 index buckets and window-limited token/latency data.
- `/observability/summary?recent_days=30` returns 30 index buckets and includes older samples inside 30 days.
- Unsupported `recent_days` remains rejected.

### U3: Contract additions for latency trends

**Goal:** Add trend data for P90/P99 charts without breaking the existing dashboard.

**Files:**
- Modify: `src/lib/contracts/search.ts`
- Modify: `src-tauri/src/services/search/client.rs`
- Modify: `src/features/home/components/HomeDashboard.tsx`
- Modify: `src/features/home/components/HomeDashboard.test.tsx`
- Test: `src/features/search/api/searchClient.test.ts`
- Test: Rust DTO tests in `src-tauri/src/services/search/client.rs`

**Approach:**
- Add `latency_trends` to the sidecar JSON payload keyed by latency kind.
- Each trend point includes `bucket`, `sample_count`, `failure_count`, `p90_ms`, and `p99_ms`.
- Mirror this in Rust DTOs and TypeScript contracts as optional/defaulted fields.
- Home can initially keep rendering the existing percentile rows; trend rendering can be a small inline P90/P99 sparkline if it remains compact. If visual scope grows, keep the contract addition and defer chart polish.

**Test Scenarios:**
- Rust DTO decodes sidecar trend points and serializes camelCase.
- TypeScript test fixtures include `latencyTrends` without breaking existing Home rendering.
- Home still renders current latency rows when trend arrays are empty.

### U4: Verification

**Goal:** Prove persistence and contract compatibility.

**Files:**
- Test files listed above.

**Verification:**
- `cd sidecar && uv run pytest tests/test_observability.py tests/test_search_route.py tests/test_chat_routes.py tests/test_index_runner.py`
- `npm test -- HomeDashboard searchClient`
- `cargo test --manifest-path src-tauri/Cargo.toml observability_round_trips_snake_to_camel`
- `npm run build`
- `git diff --check`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`

## Sequencing

1. U1: Add SQLite-backed store and persistence tests.
2. U2: Wire lifecycle and route window handling.
3. U3: Add additive trend contract and minimal Home compatibility.
4. U4: Run targeted verification, then build.

## Risks

| Risk | Mitigation |
| --- | --- |
| Observability DB grows without bound | Apply 90-day retention on open/write and keep only metadata samples |
| Percentile queries become slow | Window is limited to 7/30 days; add histogram rollups later only if needed |
| Sensitive data leaks into metrics | Recorder API accepts only allowlisted scalar fields and ignores raw provider payloads except token count keys |
| Contract churn breaks Home | Additive `latency_trends` with default empty arrays; keep existing `latency` and `token_usage` fields |
| SQLite corruption blocks sidecar startup | Mirror queue corruption recovery: rename corrupt DB and recreate empty observability DB |
