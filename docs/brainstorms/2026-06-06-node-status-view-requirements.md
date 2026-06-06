---
date: 2026-06-06
topic: node-status-view
---

# Node Status View

## Summary

CogniOS should expose one unified per-node status view that shows what each node is doing now, what its expected processing stages are, and the last result of each stage. The UI initializes from a persisted snapshot, stays current through status-change events, and presents one primary status in dense lists while preserving full stage detail in hover/click surfaces and the Inspector.

---

## Problem Frame

CogniOS now has several node-specific processing paths. URL nodes crawl and index, images index and can run enhancement, and voice notes transcribe, summarize, and index. Each path has its own status vocabulary, which makes the UI hard to keep consistent and makes new node capabilities likely to add more one-off state fields.

The user-facing problem is not only whether a node is indexed. Users need to know what is happening now, which stage failed, whether usable content is already available, and what the last crawler/transcription/enhancement result was. A single coarse `ready` or `indexed` state cannot carry that without hiding useful partial results or making the UI type-specific.

---

## Actors

- A1. User: Looks at the Explorer, hover/click detail, and Inspector to understand whether a node is usable and what is still running or failed.
- A2. Explorer UI: Renders dense node lists with a single primary status and optional detailed status surfaces.
- A3. CogniOS app status registry: Persists the current stage snapshot for every node and emits status-change events.
- A4. Background processors: URL crawler, search/indexing, image enhancement, voice transcription, and voice summarization write stage updates into the registry.

---

## Key Decisions

- **Status is a UI-facing view, not task orchestration.** Queue and worker systems still decide what runs; the status registry explains the result and current progress to the user.
- **Current stage snapshots are persisted.** Each stage keeps its current or last-run status, including enough detail to explain the last crawler/index/transcription/enhancement result after the work finishes.
- **Full history is deferred.** The first version does not need an append-only event timeline; it only needs the latest state for each stage.
- **Snapshot plus event delta is the realtime contract.** UI surfaces fetch a complete snapshot first, then apply incremental status-change events.
- **Node kinds define static default stages.** A node should show the expected work immediately after creation, even before every processor has started.
- **`partial` is a first-class overall status.** Nodes can be usable while an optional stage failed.

---

## Key Flows

- F1. Node appears with expected stages
  - **Trigger:** A supported node is created or discovered.
  - **Actors:** A2, A3, A4
  - **Steps:** CogniOS assigns the node kind's default stages, persists pending/runnable stage state, and includes the node in the next status snapshot.
  - **Outcome:** The UI can show what will happen before background work has completed.
  - **Covered by:** R1, R2, R3

- F2. UI opens and becomes live
  - **Trigger:** The Explorer or another node-listing surface mounts.
  - **Actors:** A2, A3
  - **Steps:** The UI fetches a full node status snapshot, stores it locally, subscribes to status-change events, and applies each event by replacing that node's status view.
  - **Outcome:** The UI is correct on first render and remains realtime without requiring every page to query each subsystem.
  - **Covered by:** R4, R5, R6

- F3. Stage updates while work runs
  - **Trigger:** A processor starts, progresses, succeeds, fails, retries, or is skipped.
  - **Actors:** A3, A4, A2
  - **Steps:** The processor writes the stage update, the registry persists the latest stage snapshot, recomputes the node's overall status, and emits a node-level change event.
  - **Outcome:** The UI shows one current primary state in lists and full stage detail in detailed surfaces.
  - **Covered by:** R7, R8, R9, R10

- F4. User inspects last-run detail
  - **Trigger:** The user hovers, clicks, or opens the Inspector for a processed node.
  - **Actors:** A1, A2, A3
  - **Steps:** The UI reads the node status view and displays each stage's state, timing, message, error, retryability, and last-run detail when available.
  - **Outcome:** Users can understand, for example, that URL crawling succeeded with a title and response summary while indexing failed.
  - **Covered by:** R9, R11, R12

---

## Requirements

**Unified status shape**

- R1. Every supported node must have a `NodeStatusView` with one `overall` status, an optional primary stage, and a list of stage statuses.
- R2. Each node kind must declare static default stages so the UI can show expected processing before work has started.
- R3. The default v1 stage sets must cover URL nodes, image/PDF-like enhancement candidates, and voice notes.
- R4. The frontend must consume one unified status surface instead of separately merging sidecar index state, voice note state, and URL crawler state by node type.

**Realtime contract**

- R5. UI surfaces must initialize from a full persisted status snapshot before applying live events.
- R6. Status-change events must carry enough ordering information for the UI to detect missed or stale events and refresh from snapshot.
- R7. Applying a status-change event must replace the affected node's status view without requiring a full Explorer reload.

**Stage semantics**

- R8. Stage states must support pending, running, succeeded, failed, skipped, and blocked.
- R9. A stage must preserve its current or last-run message, error, retryability, timing, attempt count, and stage-specific detail when available.
- R10. Finished stages must remain visible as last-run results until the next run resets or updates that stage.
- R11. Stage-specific detail must be displayable without requiring the list UI to understand the node kind.

**Overall status and display**

- R12. Dense node rows must show one primary status only.
- R13. Hover/click detail and Inspector must show the complete ordered stage list.
- R14. Overall status must distinguish running, queued, ready, partial, failed, unsupported, and idle-like states.
- R15. Optional stage failure must produce `partial` rather than hiding the failure under `ready`.
- R16. Required stage failure must produce `failed` unless another required stage is actively running and should be shown as the primary current work.
- R17. Overall status must make usable-but-incomplete content visible without implying that every stage succeeded.

**Known stage defaults**

- R18. URL nodes must include crawl and content indexing stages.
- R19. Image or image-enhanceable document nodes must include content indexing and enhancement stages, with enhancement treated as optional when basic indexed content is usable.
- R20. Voice notes must include transcription, summarization, and content indexing stages, with summarization treated as optional when transcript and index are usable.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R18.** Given a URL node is created, when the Explorer renders before background work completes, the node's detail surface shows crawl and index stages rather than a single undifferentiated pending state.
- AE2. **Covers R5, R6, R7.** Given the Explorer opens after several nodes are already processing, when the UI fetches the snapshot and then receives status-change events, it shows current state immediately and updates individual nodes without reloading the tree.
- AE3. **Covers R9, R10, R11.** Given URL crawling succeeded and indexing failed, when the user opens status detail, the crawl stage still shows its last successful result while the index stage shows the failure.
- AE4. **Covers R12, R13.** Given a voice note has transcription running, summary pending, and indexing pending, when it appears in the node list, the row shows one primary transcribing state; when the user opens detail, all three stages are visible.
- AE5. **Covers R15, R17, R20.** Given a voice note transcript and index succeed but summarization fails, when the node appears in the Explorer, the overall status is partial rather than ready or failed.
- AE6. **Covers R15, R19.** Given an image is indexed with basic OCR but advanced enhancement fails, when the user views the node, the node remains usable and shows partial status with enhancement failure detail.
- AE7. **Covers R16, R18.** Given a URL crawl fails before content can be indexed, when the node appears in the Explorer, the overall status is failed because a required stage failed.
- AE8. **Covers R4.** Given URL, image, and voice note nodes are visible together, when the UI renders their statuses, it uses the same status contract for all of them.

---

## Success Criteria

- Users can tell from the Explorer which node is actively processing, partially usable, failed, or ready without opening a type-specific screen.
- Inspector and hover/click detail explain the stage-level reason behind the row status.
- App restart or UI remount does not lose the latest known stage state for each node.
- New processing capabilities can be added by declaring stage defaults and writing stage updates, without changing the dense node-row status model.
- A planner can proceed without inventing the semantics of `partial`, last-run stage detail, snapshot initialization, or event-based realtime updates.

---

## Scope Boundaries

- No append-only status history or audit timeline in v1.
- No requirement for the status registry to schedule, prioritize, or retry work.
- No per-node-type frontend aggregation of separate subsystem status APIs.
- No requirement that every stage report numeric progress; text messages and coarse states are acceptable.
- No requirement that dense node rows show every stage label inline.
- No dynamic stage discovery in v1 beyond the static stage set declared for each node kind.

---

## Dependencies / Assumptions

- CogniOS app storage remains the source of truth for UI-facing node status.
- Existing URL, indexing, enhancement, and voice-note processors can report stage transitions at their natural boundaries.
- Existing `nodes.state` can remain a coarse compatibility surface while the richer status view powers detailed UI.
- Some stage-specific details are inherently different across processors; the common contract needs to display them, not normalize every field into one universal schema.

---

## Sources / Research

- `src-tauri/src/domain/vfs/state.rs` currently defines the coarse node states used by the Explorer.
- `src/lib/contracts/search.ts` defines aggregate and per-node indexing status contracts.
- `sidecar/search_sidecar/routes/index.py` exposes sidecar indexing status and per-node queue status.
- `src/lib/contracts/voiceNote.ts` shows voice notes already carry separate capture, transcription, and summary statuses.
- `docs/brainstorms/2026-05-11-voice-note-requirements.md` established the voice-note processing stages that this unified status view must cover.
