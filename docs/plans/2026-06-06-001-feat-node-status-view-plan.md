---
title: "feat: Add unified node status view"
type: feat
status: implemented
date: 2026-06-06
origin: docs/brainstorms/2026-06-06-node-status-view-requirements.md
---

# feat: Add unified node status view

## Summary

Implement a unified per-node status view for CogniOS. Each supported node exposes an overall status plus ordered processing stages, the stage snapshot is persisted in the Tauri app database, and the frontend initializes from a status snapshot before applying realtime node-status change events.

## Problem Frame

Explorer rows currently depend on a coarse `nodes.state` value, while URL crawling, indexing/enhancement, and voice note processing each carry more detailed status elsewhere. That forces UI surfaces to either hide useful work detail or become node-type-specific. The richer status view should become the UI-facing source for current processing state while leaving existing queues and workers responsible for task scheduling.

## Plan Requirements

- PR1. A node status view contains one overall state, an optional primary stage, and ordered stage snapshots.
- PR2. Stage snapshots persist the latest/current state, message, retryability, attempt count, timing, and stage-specific detail where available.
- PR3. URL, image/PDF enhancement candidates, and voice notes have static default stages.
- PR4. The UI initializes from a complete persisted snapshot and then applies incremental events.
- PR5. Dense Explorer rows show one primary status; hover/click detail and Inspector show all stages.
- PR6. `partial` is a first-class overall state when optional work failed but usable required work succeeded.
- PR7. The status registry is display state only; it does not schedule, prioritize, or retry work.

**Origin mapping:** PR1-PR2 map R1, R8-R11; PR3 maps R2-R3 and R18-R20; PR4 maps R5-R7; PR5 maps R12-R14; PR6 maps R15-R17; PR7 preserves the Scope Boundaries from the origin.

## Scope Boundaries

- No append-only `node_status_events` history table in this slice.
- No task orchestration or retry scheduling in the status registry.
- No frontend per-node-kind status merger.
- No requirement that every stage reports numeric progress.
- No dense-row display of every stage label.
- No dynamic stage discovery beyond the static stage defaults declared for known node kinds.
- Existing `nodes.state` remains as a coarse compatibility surface during this slice.

## Existing Patterns To Follow

- Coarse node states live in `src-tauri/src/domain/vfs/state.rs` and are rendered by `src/features/explorer/components/NodeStateDot.tsx`.
- Explorer snapshot commands and mutation commands live in `src-tauri/src/commands/mod.rs`, `src/lib/tauri/ipc.ts`, and `src/features/explorer/store/useExplorerStore.ts`.
- Sidecar index changes are synchronized by `src-tauri/src/services/search/index_state_sync.rs`; this is the natural hook for updating `content.index` and `image.enhance` stages.
- Sidecar indexing and enhancement aggregate status currently come from `src/lib/contracts/search.ts`, `src-tauri/src/services/search/client.rs`, and `sidecar/search_sidecar/routes/index.py`.
- Voice note lifecycle state is modeled in `src/lib/contracts/voiceNote.ts` and `src-tauri/src/services/voice_notes/mod.rs`.
- Tauri event patterns exist for `vfs://changed` and `models/progress`.

## Key Technical Decisions

- **Rust/Tauri owns the registry.** The app database already owns `nodes`, URL metadata, and voice note metadata, so it is the right place to persist UI-facing status.
- **Use stage defaults as a registry definition.** A small Rust definition maps node kind and metadata to expected stages. Processors update those stage rows as work progresses.
- **Store stage snapshots, derive node views.** Persist per-stage rows and compute `NodeStatusView` on read/update. That avoids duplicating aggregate state while keeping snapshot reads straightforward.
- **Emit node-level events.** A stage update recomputes one node's status view and emits one `node-status://changed` event with a monotonic revision.
- **Bridge existing sidecar changes first.** The current sidecar delta loop already sees indexing transitions; extending it gives immediate value without changing sidecar scheduling.
- **Keep row UI quiet.** Replace the dense row's coarse state dot with a primary status indicator that still suppresses uninteresting ready/indexed states when appropriate.

## Implementation Units

### U1. Persisted node status registry

**Goal:** Add the database schema, domain types, and repository functions for persisted stage snapshots and derived node views.

**Files:**
- Modify: `src-tauri/src/infrastructure/db/migrations.rs`
- Add: `src-tauri/migrations/0009_node_statuses.sql`
- Add: `src-tauri/src/domain/node_status/mod.rs`
- Add: `src-tauri/src/infrastructure/db/node_status_repository.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/infrastructure/db/mod.rs`
- Test: `src-tauri/tests/node_statuses.rs`

**Approach:**
- Create a `node_statuses` table keyed by `(node_id, stage_id)`.
- Include current state, stage label, ordering, required/optional flag, timestamps, message, error, retryability, attempt count, detail JSON, and a monotonic revision source.
- Define stage defaults for URL, file/image-enhanceable content, note, voice note, and unsupported/plain nodes.
- Provide repository functions to ensure default stages for a node, upsert one stage, list a full snapshot, and derive a single node view.
- Derive `overall` and `primary_stage_id` from the stage list using the origin's precedence rules.

**Test Scenarios:**
- Fresh migration creates the stage table and indexes.
- Ensuring defaults for URL creates crawl and content index stages in order.
- Ensuring defaults for voice note creates transcription, summarization, and content index stages.
- Optional-stage failure produces `partial` when required stages succeeded.
- Required-stage failure produces `failed`.
- Running stage wins as the primary displayed status.
- Finished stages remain present with last-run detail after success or failure.

### U2. Tauri commands and realtime event contract

**Goal:** Expose snapshot reads and node-level change events to the frontend.

**Files:**
- Add: `src-tauri/src/commands/node_status.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/contracts/nodeStatus.ts`
- Modify: `src/lib/tauri/ipc.ts`
- Add: `src/features/node-status/api/nodeStatusClient.ts`
- Test: `src-tauri/tests/node_statuses.rs`
- Test: `src/features/node-status/api/nodeStatusClient.test.ts`

**Approach:**
- Add `get_node_status_snapshot` and `get_node_status` commands.
- Return a snapshot containing `revision` plus a `nodes` map keyed by node id.
- Emit `node-status://changed` events after registry writes with `{ revision, nodeId, status }`.
- Make event revision monotonic enough for the frontend to detect stale/missed updates and refresh from snapshot.

**Test Scenarios:**
- Snapshot command returns default stages for existing nodes.
- Single-node command returns the derived view for that node.
- Updating a stage increments revision and emits the expected event payload.
- Unknown node returns an empty/unsupported view or a typed error consistently.

### U3. Wire existing processors into the registry

**Goal:** Update node stages from current URL, index, enhancement, and voice note flows without changing how work is scheduled.

**Files:**
- Modify: `src-tauri/src/infrastructure/db/url_repository.rs`
- Modify: `src-tauri/src/services/search/index_state_sync.rs`
- Modify: `src-tauri/src/services/search/advanced_ocr_watcher.rs`
- Modify: `src-tauri/src/services/voice_notes/mod.rs`
- Modify: `src-tauri/src/commands/voice_notes.rs`
- Test: `src-tauri/tests/url_indexing.rs`
- Test: `src-tauri/tests/voice_notes.rs`
- Test: `src-tauri/tests/node_statuses.rs`

**Approach:**
- URL creation initializes `url.crawl` and `content.index` stages.
- URL crawler completion/failure writes `url.crawl` last-run detail and lets indexing updates drive `content.index`.
- `index_state_sync` maps sidecar transitions to `content.index` stage state while still maintaining `nodes.state`.
- Enhancement watcher/backfill/index status updates set `image.enhance` to pending/running/succeeded/failed where the current code has enough signal; absent fine-grained completion may remain pending until a later sidecar stage event if the signal is not available.
- Voice note status transitions update `voice.transcribe`, `voice.summarize`, and `content.index` stages from existing metadata.

**Test Scenarios:**
- URL node creation initializes crawl/index stages and starts with queued overall status.
- Successful URL indexing preserves crawl success detail and content index success.
- Sidecar error transition marks `content.index` failed and overall failed for required index stages.
- Voice note transcript completed but summary failed yields partial overall.
- Existing `nodes.state` synchronization still works for Explorer compatibility.

### U4. Frontend status store and Explorer display

**Goal:** Use the unified status view in Explorer rows, hover/click detail, and Inspector.

**Files:**
- Add: `src/features/node-status/store/useNodeStatusStore.ts`
- Add: `src/features/node-status/hooks/useNodeStatusSubscription.ts`
- Add: `src/features/explorer/components/NodeStatusIndicator.tsx`
- Add: `src/features/explorer/components/NodeStatusPopover.tsx`
- Modify: `src/features/explorer/components/ExplorerRow.tsx`
- Modify: `src/features/explorer/components/ExplorerInspector.tsx`
- Modify: `src/features/explorer/components/NodeStateDot.tsx`
- Modify: `src/features/explorer/components/ExplorerLayout.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/styles/app.css`
- Test: `src/features/explorer/components/NodeStatusIndicator.test.tsx`
- Test: `src/features/explorer/components/ExplorerInspector.test.tsx`
- Test: `src/app/App.test.tsx`

**Approach:**
- Load `get_node_status_snapshot` when the app loads the Explorer snapshot.
- Subscribe to `node-status://changed`; if revisions jump, refresh the snapshot.
- Row display uses one primary indicator derived from `NodeStatusView`, with uninteresting ready/indexed states kept visually quiet.
- Hover/click detail shows ordered stages and last-run detail.
- Inspector replaces the single coarse State row with a richer Processing section.

**Test Scenarios:**
- App loads node status snapshot on startup.
- Event updates replace one node's status without changing the Explorer snapshot.
- Dense row shows one primary running/failed/partial state.
- Inspector shows all stages with messages and error detail.
- Revision gap triggers snapshot refresh.

### U5. Verification and compatibility

**Goal:** Prove the new status view is compatible with existing coarse state behavior and does not regress existing node flows.

**Files:**
- Test: `src-tauri/tests/node_statuses.rs`
- Test: `src-tauri/tests/url_indexing.rs`
- Test: `src-tauri/tests/voice_notes.rs`
- Test: `src/features/explorer/components/NodeStatusIndicator.test.tsx`
- Test: `src/app/App.test.tsx`

**Verification run:**
- `cargo fmt --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml --test node_statuses`
- `cargo test --manifest-path src-tauri/Cargo.toml --test url_indexing`
- `cargo test --manifest-path src-tauri/Cargo.toml --test voice_notes`
- `npm test -- src/features/explorer/components/NodeStatusIndicator.test.tsx src/features/explorer/components/ExplorerInspector.test.tsx src/app/App.test.tsx`
- `npm run build`
- `git diff --check`

## Sequencing

1. U1: Add persisted registry and aggregation tests.
2. U2: Add Tauri commands/events and frontend contracts.
3. U3: Wire current backend processors into stage updates.
4. U4: Add frontend store and Explorer/Inspector rendering.
5. U5: Run targeted backend/frontend verification.

## Risks

| Risk | Mitigation |
| --- | --- |
| Enhancement lacks enough existing per-node completion signal for precise stage updates | Land the common stage contract now and map only the signals currently available; keep unknown enhancement detail honest |
| New status view diverges from `nodes.state` | Keep `nodes.state` as compatibility, and test that sidecar index sync still updates both surfaces |
| Frontend event loss causes stale status | Snapshot-first load plus revision gap refresh recovers missed events |
| Static stage defaults need updates for future node capabilities | Keep stage definitions centralized and tested |
| UI becomes noisy in dense rows | Preserve the one-primary-status rule and show full detail only on hover/click/Inspector |

## Implementation-Time Unknowns

- Exact image enhancement success/failure signal may require inspecting current sidecar queue details during implementation.
- Whether note nodes that are not voice notes should show `content.index` as a required default or stay quiet until a sidecar event appears should be decided against the current Explorer noise level.
- Stage detail JSON should start narrow and display-oriented; avoid turning it into a second domain schema.
