---
title: "feat: Build Home statistics dashboard"
type: feat
status: active
date: 2026-05-10
---

# feat: Build Home statistics dashboard

## Summary

Turn Home from a placeholder into a private observability dashboard for CogniOS. Home will show current indexing/model health, a recent indexed-node activity grid, search and indexing latency percentiles, model download progress, and provider/model token usage when usage metadata is available.

## Problem Frame

CogniOS already has useful operational counters, but they live at the bottom of Settings and read as diagnostics rather than the user's daily overview. The Home surface should answer: what has CogniOS processed recently, what is still running, where are models/providers spending time or tokens, and whether search/indexing is healthy.

The implementation should reuse existing sidecar-owned search/index/model status paths, then add privacy-safe aggregate observability for historical activity and performance. It must not expose raw prompts, retrieved source text, absolute internal paths, or hidden indexing payloads.

## Requirements

- R1. Home replaces the current stub with a statistics dashboard.
- R2. The existing Settings diagnostics counters for indexed items, in-flight work, and OCR enhancement move to Home.
- R3. Home shows recent indexed node activity in a compact GitHub-contribution-style day grid.
- R4. Home shows live model/provider readiness and active model-download progress.
- R5. Home shows search latency percentiles, including P90 and P99, from recent sidecar requests.
- R6. Home shows indexing latency percentiles from recently completed indexing and OCR-enhancement jobs.
- R7. Home shows provider/model token usage where chat providers return usage metadata.
- R8. Home degrades cleanly when the sidecar is initialising or unavailable.
- R9. Settings remains focused on configuration and no longer renders the diagnostics strip.
- R10. Observability data shown in Home is aggregate metadata only.

## Assumptions

- Token usage can start with provider-returned chat usage metadata only; local providers or flows that omit usage remain visible as "no usage reported."
- Latency histories can start as in-memory rolling sidecar samples. Durable long-term metrics and export are follow-up work.
- Recent indexed activity counts should use sidecar queue completion timestamps, not VFS metadata updates or rename/resync churn.
- The first dashboard can use lightweight SVG/CSS charts instead of adding a charting dependency.

## Scope Boundaries

- No billing, quota enforcement, or cost forecasting.
- No prompt/body/source-content logging for analytics.
- No long-term telemetry database or cloud sync.
- No per-node OCR enhancement drilldown.
- No new third-party charting dependency.
- No Memory Timeline implementation.

## Context & Research

### Relevant Code and Patterns

- `src/app/App.tsx` currently routes Home to the placeholder panel.
- `src/app/AppSidebar.tsx` already exposes the Home navigation item.
- `src/features/settings/components/SettingsDiagnostics.tsx` computes current engines/model/index/OCR counters from settings, model status, and index status.
- `src/features/settings/hooks/useSearchSubsystemStatus.ts` polls `/models/status` and `/index/status`.
- `src/features/settings/hooks/useModelDownloadProgress.ts` subscribes to `models/progress` events.
- `src/lib/contracts/search.ts`, `src/features/search/types/search.ts`, and `src/features/search/api/searchClient.ts` mirror Tauri-facing search contracts.
- `sidecar/search_sidecar/routes/index.py` exposes aggregate queue and index status.
- `sidecar/search_sidecar/routes/search.py` is the natural point to time search requests.
- `sidecar/search_sidecar/index/runner.py` already measures indexing and advanced-OCR elapsed time in logs.
- `sidecar/search_sidecar/chat/orchestrator.py` already receives provider/model usage metadata in chat generation responses.

### Institutional Learnings

- `docs/plans/2026-05-03-001-feat-two-pass-image-ocr-plan.md` chose aggregate OCR enhancement counters instead of per-node enhancement UI. Home should preserve that aggregate pattern.
- `docs/plans/2026-05-09-001-feat-content-index-versioning-plan.md` fixed metadata-only churn resetting index state. Recent indexed-node counts should count real indexing completions.
- `docs/security/chat-trust-boundaries.md` forbids exposing hidden retrieval details and raw source material as routine UI/log data.

### External References

- GitHub contribution graphs are a useful model for low-detail day-level activity overview.
- Grafana-style stat panels and status timelines support the "current state plus history" structure.
- Prometheus/OpenTelemetry guidance favors histograms/percentiles for latency and GenAI token usage metrics over averages.

## Key Technical Decisions

- **Home owns observability display; sidecar owns observability data.** React should not infer historical latency or activity from UI events. Sidecar routes can aggregate the queue, model, search, and chat facts it already owns.
- **One new aggregate observability contract.** Add a sidecar/Tauri/search-client observability endpoint rather than expanding unrelated status endpoints with many historical fields.
- **In-memory rolling samples for v1.** Recent latency and token usage are operational signals, not records. Keeping them in sidecar memory avoids migrations and privacy risk while still making Home useful during a session.
- **Queue-backed recent index counts.** Use `jobs.indexed_at` grouped by local date for recent activity. This is closer to "nodes processed" than `indexedChunks`.
- **Settings diagnostics logic becomes reusable.** Move summary rendering helpers/components into a Home-friendly surface and remove the Settings diagnostics strip.
- **Charts stay dependency-free.** Heatmap and sparkline/percentile visuals use CSS/SVG/semantic HTML in app styles.

## Implementation Units

### U1: Sidecar observability aggregation

**Goal:** Expose privacy-safe historical aggregates for Home.

**Files:**
- Create: `sidecar/search_sidecar/observability.py`
- Create: `sidecar/search_sidecar/routes/observability.py`
- Modify: `sidecar/search_sidecar/app.py`
- Modify: `sidecar/search_sidecar/routes/__init__.py`
- Modify: `sidecar/search_sidecar/routes/search.py`
- Modify: `sidecar/search_sidecar/routes/chat.py`
- Modify: `sidecar/search_sidecar/index/runner.py`
- Modify: `sidecar/search_sidecar/index/queue.py`
- Test: `sidecar/tests/test_observability.py`
- Test: `sidecar/tests/test_index_queue.py`
- Test: `sidecar/tests/test_search_route.py`

**Approach:**
- Add a small rolling metrics store with methods to record search durations, indexing durations, model-download durations when available, and provider/model token usage.
- Add percentile helpers for P50/P90/P99 and bounded recent samples.
- Add a queue helper that groups recent `indexed_at` completions by day for the last N days.
- Mount `GET /observability/summary` returning recent indexed days, search latency summary, indexing latency summary, token usage by provider/model, and empty/model-download sections when no samples exist.
- Time `/search` route calls and record successful/failed request durations.
- Record indexing and enhancement elapsed durations in `IndexingRunner` alongside existing logs.
- Record chat token usage in `/chat/turns`, `/chat/turns/stream`, and `/chat/memory/refresh` when generation responses include usage.

**Test Scenarios:**
- Percentile helper returns stable values for empty, single, and multiple samples.
- `/observability/summary` returns empty-but-valid sections before any samples.
- Search route records elapsed time without changing the search response.
- Index queue day grouping counts only rows with `state='indexed'` and `indexed_at`.
- Token usage aggregates by provider/model and ignores missing usage safely.

### U2: Tauri and TypeScript observability contract

**Goal:** Make the sidecar observability summary available to React through existing search-client patterns.

**Files:**
- Modify: `src-tauri/src/services/search/client.rs`
- Modify: `src-tauri/src/commands/search.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri/ipc.ts`
- Modify: `src/lib/contracts/search.ts`
- Modify: `src/features/search/types/search.ts`
- Modify: `src/features/search/api/searchClient.ts`
- Test: existing Rust client DTO tests in `src-tauri/src/services/search/client.rs`
- Test: `src/features/search/api/searchClient.test.ts`

**Approach:**
- Add DTOs mirroring the sidecar observability payload with camelCase serialization to TypeScript.
- Add `get_search_observability` Tauri command and `searchClient.observability()`.
- Preserve the same `SidecarEnvelope<T>` degradation behavior used by existing index/model status calls.

**Test Scenarios:**
- Rust DTO decodes snake_case sidecar payload and serializes camelCase to TypeScript.
- IPC wrapper calls the expected Tauri command with no arguments.
- Search client exposes the method in test stubs.

### U3: Home statistics UI

**Goal:** Replace the Home placeholder with a complete statistics dashboard.

**Files:**
- Create: `src/features/home/components/HomeDashboard.tsx`
- Create: `src/features/home/components/HomeDashboard.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/App.test.tsx`
- Modify: `src/styles/app.css`

**Approach:**
- Home polls settings/model/index status and observability summary.
- Render current KPI cards for indexed items, queue depth, in-flight jobs, OCR enhancement, configured engines, and ready model roles.
- Render a day-level activity heatmap for recent indexed node counts.
- Render percentile sections for search and indexing latency with P50/P90/P99 values and compact trend rows.
- Render provider/model token usage totals when present.
- Render model download progress using existing `models/progress` event state.
- Keep empty/initialising/unavailable states informative but compact.

**Test Scenarios:**
- Home navigation renders dashboard instead of placeholder.
- Dashboard renders current indexed/in-flight/OCR counters from ready status envelopes.
- Dashboard renders a recent activity grid from observability data.
- Dashboard renders latency percentiles and token usage when present.
- Dashboard degrades cleanly when observability is initialising/unavailable.

### U4: Move diagnostics out of Settings

**Goal:** Keep Settings focused on configuration while preserving the metrics in Home.

**Files:**
- Modify: `src/features/settings/components/SettingsLayout.tsx`
- Modify: `src/features/settings/components/SettingsLayout.test.tsx`
- Modify or delete: `src/features/settings/components/SettingsDiagnostics.tsx`
- Modify: `src/styles/app.css`

**Approach:**
- Remove the bottom diagnostics strip from Settings.
- Reuse or move pure summary helper logic if Home needs it.
- Leave provider configuration, feature rows, restart banner, and diagnostics error handling intact.

**Test Scenarios:**
- Settings no longer renders the Diagnostics summary.
- Settings still loads settings and provider sections correctly.
- Existing provider/model status UI remains unaffected.

### U5: Verification and visual polish

**Goal:** Prove the dashboard works and fits the existing app design.

**Files:**
- Test files listed above.
- `src/styles/app.css`

**Approach:**
- Run targeted frontend tests, sidecar tests, Rust DTO tests, and the full build.
- Start the Vite dev server and inspect Home in the browser at desktop and narrow widths.
- Check charts for non-overlap, readable labels, and empty states.

**Test Scenarios:**
- `npm test -- HomeDashboard App SettingsLayout searchClient`
- `cd sidecar && uv run pytest tests/test_observability.py tests/test_index_queue.py tests/test_search_route.py`
- `cargo test --manifest-path src-tauri/Cargo.toml search::client`
- `npm run build`

## Sequencing

1. U1 sidecar aggregation.
2. U2 Tauri/TypeScript contract.
3. U3 Home dashboard.
4. U4 Settings cleanup.
5. U5 verification and visual pass.

## Risks

| Risk | Mitigation |
| --- | --- |
| Percentiles imply long-term truth but samples are session-local | Label as recent/session-scoped and keep durable metrics out of v1 |
| Token usage schemas vary by provider | Normalize known `prompt_tokens`, `completion_tokens`, and `total_tokens`; keep unknown usage ignored or preserved only as aggregate counts |
| Home becomes too dense | Use current-state cards first, then compact historical sections |
| Metrics accidentally expose sensitive content | Store only durations, counts, provider IDs, model IDs, and token counts |
| Settings tests depend on Diagnostics text | Update tests to assert Settings configuration behavior and Home ownership |

