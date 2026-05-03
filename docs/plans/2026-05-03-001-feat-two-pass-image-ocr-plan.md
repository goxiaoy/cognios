---
title: Two-Pass Image OCR
type: feat
status: active
date: 2026-05-03
deepened: 2026-05-03
origin: docs/brainstorms/2026-05-03-two-pass-image-ocr-requirements.md
---

# Two-Pass Image OCR

## Overview

Split image indexing into two passes: a fast basic OCR pass that makes every image searchable in seconds, and a slow advanced OCR pass (PP-StructureV3 local) that runs as a background enhancement and replaces only the body chunks. Captions stay where they are. Backfill on first enable is triggered by the existing local-bundle watcher (repurposed). Cloud advanced-OCR backfill is **not** auto-triggered in v1 — users invoke it manually via the inspector's Reindex action; the brainstorm's R10 cloud trigger is descoped here for cost-safety reasons (see Key Technical Decisions).

## Problem Frame

Today, when Advanced OCR is enabled, `ImageProcessor` runs the slow extractor first and only falls back to the fast one when advanced returns empty. For a 10k-image library, that's hours-to-days of indexing during which nothing is searchable. The basic extractor is "good enough" for non-document images, so making the user wait on the slow extractor on every image is poor UX.

The two-pass design (origin: [docs/brainstorms/2026-05-03-two-pass-image-ocr-requirements.md](../brainstorms/2026-05-03-two-pass-image-ocr-requirements.md)) gives users immediate searchability and lets quality compound opportunistically. No per-folder opt-in; behavior is global when Advanced OCR is bound.

## Terminology

- **Advanced extractor available** — the `ImageProcessor` instance was constructed with a non-`None` `_advanced_ocr_extract`. This is determined at sidecar boot from `select_advanced_ocr_extractor(settings, model_manager)` in [sidecar/search_sidecar/lifecycle.py](../../sidecar/search_sidecar/lifecycle.py). It is the only signal the runner consults at claim time. Settings changes that flip this require a sidecar restart (already enforced by `needs_restart` on the relevant settings PUTs).
- **Backlog row** — a `jobs` row with `state='indexed'` AND `enhancement_pending=1` AND `enhancement_failed=0` AND `enhancement_attempts < MAX_ENHANCEMENT_ATTEMPTS`. The runner's `claim_next_enhancement` returns these.
- **Internal flag** — the `enhancement_pending`/`enhancement_failed`/`enhancement_attempts` columns on the sidecar's `jobs` table. They never appear in the explorer UI or in the Rust `nodes.state` value. Rust learns about them only via the additive `IndexStatus` payload extension in Unit 6.

## Requirements Trace

**Basic pass & user-visible state**

- **R1.** When `image-ocr` is bound, basic pass runs and the node transitions to `indexed` as soon as basic chunks land.
- **R4.** Captions are produced once during the basic pass and not re-run during enhancement.
- **R12.** Reindex action triggers the same flow.

**Enhancement pass execution**

- **R2.** After a successful basic pass, the node is flagged for enhancement when an advanced extractor is **available** AND the basic body is non-empty.
- **R3.** Enhancement pass extracts advanced first, then on non-empty post-chunking output deletes the existing `role="body"` chunks and writes the new ones. Summary chunks are never touched.
- **R5.** Empty advanced output (after `chunk_text`, see Unit 3) → keep basic chunks, clear flag.
- **R6.** Enhancement failures split into transient (retry, attempts++, flag stays) vs terminal (mark `enhancement_failed=1`, basic stays, flag cleared). Cap at 3 attempts; cap-exhaust is treated as terminal.
- **R7.** Single worker drains `state='pending'` first; enhancement claims happen only when no pending work exists.
- **R8.** Enhancement state survives sidecar restart (columns on `jobs`).

**Lifecycle & bindings**

- **R9.** Same flow applies when Advanced OCR is bound to a cloud provider — but cloud backfill is manual in v1 (see Scope Boundaries).
- **R10.** Backfill on first **local-bundle** ready is driven by the existing watcher, repurposed. Backfill is idempotent.
- **R11.** Re-enqueue (file-mod) resets `enhancement_pending=0`, `enhancement_failed=0`, `enhancement_attempts=0`; basic-pass completion handler re-sets the flag on success.
- **R13.** Advanced OCR unavailable → runner skips the enhancement tier (no claim, no error mark); flags survive and resume on re-enable.

## Scope Boundaries

- **No layout pre-classifier.** Both extractors run on every image when Advanced is available.
- **No per-folder opt-in.** Global behavior. (Origin decision; see Risks for the device-UX consequences.)
- **No new explorer state.** Node is `indexed` once basic chunks land. The enhancement flag is sidecar-internal — Rust learns counts via `/index/status`, not per-node state. (Per-node visibility is a separate plan if needed.)
- **No retry on terminal enhancement failures.** Basic chunks are the floor.
- **Captioning unchanged.** Runs once in the basic pass.
- **Single indexing thread.** Two-tier draining inside the existing runner; no worker pool.
- **No backfill of pre-existing chunks with `role IS NULL`.** The chunk-role refactor ([docs/plans/2026-05-02-001-refactor-chunk-role-schema-plan.md](2026-05-02-001-refactor-chunk-role-schema-plan.md)) coerces; we don't re-handle legacy NULLs.
- **No automatic cloud backfill on cloud-binding transitions.** A user binding advanced-ocr to a cloud provider does NOT trigger an automatic 50k-image cloud OCR backfill. Cloud cost surprise is a serious failure mode and the existing CloudEgressConsentDialog pattern doesn't yet cover this case. v1: cloud backfill is via the inspector's Reindex action (per-node) or via re-enabling the binding manually after a sidecar restart that triggers the local-bundle path. A bulk-cloud-backfill action is a separate plan.
- **`image-ocr` stays bound to `local-paddleocr`.** Factory asserts; cloud bindings flow only through the advanced extractor.

## Context & Research

### Relevant Code and Patterns

- **Queue & schema:** [sidecar/search_sidecar/index/queue.py](../../sidecar/search_sidecar/index/queue.py). `_ensure_schema` (lines 451-502) is the migration template. `enqueue` upsert at line 116 zeroes state-derived fields; we extend it. `claim_next` at line 182 is the model for `claim_next_enhancement`. `_lock` is a `threading.RLock` (line 112), so reentrant calls inside the runner are safe (verified by feasibility review).
- **Runner loop:** [sidecar/search_sidecar/index/runner.py](../../sidecar/search_sidecar/index/runner.py). `process_one` at line 82, `_handle` at line 110.
- **Image processor:** [sidecar/search_sidecar/index/processors/image.py](../../sidecar/search_sidecar/index/processors/image.py). Already imports `IndexingJob` from `..queue` (line 41), so the new constructor `queue: IndexingQueue` parameter introduces no circular dep (verified).
- **LanceDB store:** [sidecar/search_sidecar/storage/lancedb_store.py](../../sidecar/search_sidecar/storage/lancedb_store.py). Predicate language supports `AND`/`OR` composition (verified against `retrieval/filters.py:89`). `_quote` helper at line 440. **Important:** the lance store has no shared lock with `queue.db` — see ADV-001 mitigation in Unit 3.
- **Dispatcher:** [sidecar/search_sidecar/index/dispatch.py](../../sidecar/search_sidecar/index/dispatch.py). The `Processor` Protocol at lines 27-29 only declares `can_handle`/`process`; we add a typed `image_processor` attribute on the Dispatcher rather than adding a Protocol method.
- **Lifecycle:** [sidecar/search_sidecar/lifecycle.py](../../sidecar/search_sidecar/lifecycle.py). Dispatcher constructed at lines 121-141; `_run_reembed_sweep` at lines 227-237 is the precedent pattern for try/except'd startup hooks (Unit 5 follows this shape).
- **Watcher:** [src-tauri/src/services/search/advanced_ocr_watcher.rs](../../src-tauri/src/services/search/advanced_ocr_watcher.rs). Polls `models_status` every 10 s. We change the false→true branch to call a new backfill IPC instead of fanning out per-image events.
- **Sidecar client:** [src-tauri/src/services/search/client.rs](../../src-tauri/src/services/search/client.rs). `post_envelope` at lines 443-487 is the IPC pattern.
- **Index routes:** [sidecar/search_sidecar/routes/index.py](../../sidecar/search_sidecar/routes/index.py). `/status` at line 33 is the endpoint we extend.
- **Diagnostics card:** [src/features/settings/components/SettingsDiagnostics.tsx](../../src/features/settings/components/SettingsDiagnostics.tsx). 4-cell grid; we add a 5th cell with explicit state coverage (Unit 6).

### Institutional Learnings

- **Idempotent column add (LanceDB precedent in [docs/plans/2026-05-02-001-refactor-chunk-role-schema-plan.md](2026-05-02-001-refactor-chunk-role-schema-plan.md)):** wrap migrations so concurrent restart is safe. Same expectation here for SQLite `ALTER TABLE ADD COLUMN`.
- **Cap attempts and stay in ERROR (precedent in [docs/plans/2026-05-02-002-feat-feature-oriented-settings-plan.md](2026-05-02-002-feat-feature-oriented-settings-plan.md)):** when transient retries hit cap, do *not* re-arm via the resync path. We adopt this exactly: `enhancement_failed=1` is a sticky terminal sentinel that prevents the backfill IPC from re-flagging the row.
- **Re-enqueue mid-flight (precedent in [docs/plans/2026-04-26-004-feat-cross-workspace-search-plan.md](2026-04-26-004-feat-cross-workspace-search-plan.md)):** let the in-flight job finish, treat the new event as state-reset; commit-time `transition_seq` check is the cancellation primitive.

### External References

None used; the queue + lancedb + dispatcher patterns are well-established in this repo.

## Key Technical Decisions

- **Three new columns on `jobs`, not a state enum:** `enhancement_pending INTEGER NOT NULL DEFAULT 0`, `enhancement_attempts INTEGER NOT NULL DEFAULT 0`, `enhancement_failed INTEGER NOT NULL DEFAULT 0`. Three booleans+counter parallel the existing `attempts` pattern. **Why three, not one bit:** the Diagnostics counter must distinguish "enhanced successfully" from "tried and gave up" (origin success criteria; counter would otherwise reach 100% even when 30% terminally failed). The `enhancement_failed` sentinel is sticky — only `enqueue` (file mod) or `Reindex` (origin R12) clears it.
- **Backfill predicate excludes both `pending=1` and `failed=1`:** `UPDATE jobs SET enhancement_pending=1 WHERE state='indexed' AND kind='file' AND <ext> AND enhancement_pending=0 AND enhancement_failed=0`. This closes the cap-exhaust re-flag loop (ADV-002): a terminally-failed row stays terminally-failed across watcher transitions and sidecar restarts. The user re-arms it via Reindex.
- **Mid-flight transition_seq race uses re-check AFTER lance write under queue lock (ADV-001 fix):** the LanceDB write does NOT share `queue.db`'s lock. The race is: claim → advanced extract → lance delete+upsert → … (gap) … → clear flag. Mitigation: after the lance write completes, take `queue._lock`, re-read `transition_seq`. If it has advanced (re-enqueue happened mid-flight), call `store.delete_by_node_id(node_id)` to wipe the (now-stale) advanced chunks; the pending row's basic pass will re-write everything cleanly. If unchanged, clear `enhancement_pending` as normal. The cost of the corrective wipe is one extra basic-pass cycle's worth of work — acceptable for a rare race.
- **Runtime "advanced extractor available" via Dispatcher accessor:** add `Dispatcher.image_processor: ImageProcessor | None` attribute (typed). Runner reads `dispatcher.image_processor and dispatcher.image_processor.has_advanced_ocr()` at claim time. Avoids extending the `Processor` Protocol.
- **Transient/terminal classifier in a small pure helper:** `_classify_enhancement_error(exc) -> Literal["transient", "terminal"]`. Transient set: `httpx.TransportError` family (Connect/Read/Write timeouts), `asyncio.TimeoutError`, `ConnectionError`, `httpx.HTTPStatusError` with `response.status_code in (429, 500, 502, 503, 504)`. **Explicitly terminal**: HTTP 401/403 (auth failures — retrying with the same revoked key is harmful), `paddleocr` exceptions, decode errors, everything else. Cap at 3 transient attempts; cap-exhaust → `enhancement_failed=1`.
- **Empty advanced output is checked AFTER chunking, not before (security finding F5):** `chunk_text(advanced_text)` first; if `len(chunks) == 0`, treat as empty and keep basic chunks. Prevents whitespace-only or single-character hallucinations from passing a `.strip()` truthiness check and clobbering basic chunks with garbage.
- **Watcher fires on independent transitions, no dedup (ADV-004 fix):** `last_local_all_ready: Option<bool>`. Each unbound→bound transition fires the backfill IPC. The IPC is idempotent. **Cloud-binding triggers are out of scope for v1** (see Scope Boundaries) — eliminates the unresolved cloud-readiness signal blocker (origin's deferred R1+R9 question) AND the cloud-cost auto-fire risk.
- **Diagnostics counter shape:** Settings → Diagnostics fifth cell labeled "Image OCR enhancement". Three states surfaced from `IndexStatus`: `enhancement_pending` (drainable), `enhancement_completed` (true successes), `enhancement_failed` (terminal). UI shows `completed / total` with progress bar; `failed > 0` shows a sub-label warning.
- **Startup auto-fire is wrapped in try/except (feasibility F3 fix):** `_run_advanced_ocr_backfill_on_boot` mirrors `_run_reembed_sweep` pattern. Logs warning on exception; never blocks boot.
- **Factory assertion folded into Unit 5 dispatcher wiring** (scope-guard F1 fix): the original Unit 8 was a single guard clause for a manually-edited settings.json; not enough scope for its own unit.

## Open Questions

### Resolved During Planning

- **Will the new columns survive `quick_check` corruption recovery?** Yes — recovery rebuilds from `_ensure_schema`, which after this plan includes the new columns by default.
- **Does `role IS NULL` exist?** Per the chunk-role refactor, post-refactor rows always have `role` set via `chunk_role_or_default()`. Role-aware delete won't accidentally preserve legacy NULL rows.
- **Should re-enqueue cancel an already-claimed enhancement?** No — let it finish; commit-time `transition_seq` check + corrective `delete_by_node_id` (see ADV-001 fix above) handle the race without kill-and-restart.
- **Does LanceDB compound predicate `node_id = '...' AND role = '...'` work?** Yes — verified against `retrieval/filters.py:89` (existing AND-joined predicates).
- **Is the queue's RLock reentrant enough for transition_seq mid-flight reads?** Yes — `threading.RLock` at queue.py:112; per-method `with self._lock` is safe.
- **Does adding `queue: IndexingQueue` to `ImageProcessor.__init__` create a circular import?** No — image.py already imports `IndexingJob` from `..queue` (line 41); deepening an existing edge.
- **Does the cap-exhaust re-flag loop bug exist?** Yes (adversarial ADV-002). Fixed via `enhancement_failed` sentinel column.

### Deferred to Implementation

- **HTTP error type imports.** Exact exception classes raised by the cloud OCR client (likely `httpx.HTTPStatusError` and a `RuntimeError` wrapper) verified at implementation time so `_classify_enhancement_error` matches the actual call-site.
- **PP-StructureV3 internal-error shapes.** All paddleocr exceptions default to terminal unless inspection reveals a transient class.
- **Migration test fixture for upgrade-time backfill.** Specific shape defined during implementation (inject pre-populated `queue.db` from a prior install).

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant Watcher as advanced_ocr_watcher.rs
    participant Sidecar as Sidecar HTTP
    participant Queue as IndexingQueue
    participant Runner as IndexingRunner
    participant Image as ImageProcessor
    participant Lance as LanceDBStore

    Note over Watcher: 10s tick: models_status only
    Watcher->>Watcher: detect local-bundle false→true
    Watcher->>Sidecar: POST /index/backfill-enhancement
    Sidecar->>Queue: UPDATE jobs SET enhancement_pending=1 WHERE state='indexed' AND <image ext> AND pending=0 AND failed=0
    Sidecar-->>Watcher: {flagged: N}

    loop Runner tick
        Runner->>Queue: claim_next() (state='pending')
        alt pending row exists
            Queue-->>Runner: job
            Runner->>Image: process(job)  [basic pass]
            Image->>Lance: delete_by_node_id + write body+summary
            Image->>Queue: mark_indexed
            Note over Image,Queue: if has_advanced_ocr() AND body non-empty:
            Image->>Queue: set enhancement_pending=1
        else no pending AND has_advanced_ocr
            Runner->>Queue: claim_next_enhancement()
            alt enhancement row
                Queue-->>Runner: job + claim_seq
                Runner->>Image: process_enhancement(job, claim_seq)
                Image->>Image: extract advanced + chunk_text
                alt non-empty chunks
                    Image->>Lance: delete_chunks_by_role(node_id, "body")
                    Image->>Lance: write new body chunks
                    Note over Image,Queue: under queue lock: re-read transition_seq
                    alt seq unchanged
                        Image->>Queue: clear_enhancement_pending
                    else seq advanced (mid-flight re-enqueue)
                        Image->>Lance: delete_by_node_id (corrective wipe)
                        Note over Image: pending row's basic pass will rewrite
                    end
                else empty after chunking
                    Image->>Queue: clear_enhancement_pending
                else transient error AND attempts<3
                    Image->>Queue: bump_enhancement_attempts
                    Note over Image: flag stays; will be re-claimed
                else terminal OR cap-exhausted
                    Image->>Queue: mark_enhancement_failed (pending=0, failed=1)
                end
            end
        end
    end
```

## Implementation Units

- [x] **Unit 1: Queue schema + enhancement claim API**

**Goal:** Persist enhancement state on `jobs` and expose claim/transition methods. No behavior change yet — runner still ignores them.

**Requirements:** R2, R6, R8, R10, R11

**Dependencies:** None

**Files:**
- Modify: `sidecar/search_sidecar/index/queue.py`
- Modify: `sidecar/tests/test_queue.py`

**Approach:**
- Extend `_ensure_schema` to declare three columns in `CREATE TABLE` AND in the idempotent migration block (mirror `transition_seq` pattern). No backfill needed; defaults are correct.
- `claim_next_enhancement() -> tuple[IndexingJob, int] | None`: SELECT under `_lock` from rows matching `state='indexed' AND enhancement_pending=1 AND enhancement_failed=0 AND enhancement_attempts < MAX_ENHANCEMENT_ATTEMPTS ORDER BY indexed_at ASC LIMIT 1`. Returns the job plus the row's current `transition_seq` (the "claim_seq" for the race check). Does NOT mutate state — job stays `indexed`.
- `set_enhancement_pending(node_id) -> None`: idempotent set-to-1 (only when `enhancement_failed=0`).
- `clear_enhancement_pending(node_id) -> None`: set `enhancement_pending=0`. Used on success and on empty advanced output.
- `mark_enhancement_failed(node_id) -> None`: set `enhancement_pending=0, enhancement_failed=1`. Used on terminal error and on cap-exhaust.
- `bump_enhancement_attempts(node_id) -> int`: `UPDATE ... SET enhancement_attempts = enhancement_attempts + 1` returning new value.
- `peek_transition_seq(node_id) -> int | None`: `SELECT transition_seq FROM jobs WHERE node_id=?` under `_lock`. Used by Unit 3's race check.
- `backfill_enhancement_pending(image_extensions: tuple[str, ...]) -> int`: idempotent UPDATE where `state='indexed' AND kind='file' AND <ext match> AND enhancement_pending=0 AND enhancement_failed=0`; returns affected row count.
- `enqueue` upsert (R11): on conflict, also reset all three columns to 0.
- Module constant `MAX_ENHANCEMENT_ATTEMPTS = 3`.

**Patterns to follow:**
- `transition_seq` migration block at queue.py:478-499.
- `claim_next` cursor + `self._lock` + `self._conn` transaction at lines 182-213.

**Test scenarios:**
- Happy path: legacy `queue.db` (no new columns) opens clean and gains all three columns at default 0.
- Happy path: `set_enhancement_pending` on indexed row → flag=1; idempotent re-call → still 1.
- Happy path: `claim_next_enhancement` returns rows ordered by `indexed_at ASC`; never returns `state='pending'`, never returns `enhancement_failed=1`, never returns `enhancement_attempts >= MAX`.
- Edge case: `backfill_enhancement_pending(("png","jpg"))` flags only matching extensions, only `state='indexed'`, only `pending=0 AND failed=0`; second call returns 0.
- Edge case: `enqueue` upsert on a row with `pending=1, failed=1, attempts=2` resets all three to 0 (R11).
- Edge case: `mark_enhancement_failed` survives `_ensure_schema` re-run; `enhancement_failed=1` rows are NOT re-flagged by `backfill_enhancement_pending` (closes ADV-002).
- Edge case: cap-exhaust path → after `enhancement_attempts=3`, `claim_next_enhancement` no longer returns the row.
- Error path: methods on a non-existent node_id are no-ops (UPDATE zero rows).

**Verification:**
- All three columns present after fresh install AND after legacy upgrade.
- Reopening `IndexingQueue` against the same on-disk file preserves all column values.

---

- [x] **Unit 2: LanceDB role-aware delete**

**Goal:** Provide `LanceDBStore.delete_chunks_by_role(node_id, role)` so enhancement can replace body chunks while preserving summary chunks.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `sidecar/search_sidecar/storage/lancedb_store.py`
- Modify: `sidecar/tests/test_lancedb_store.py`

**Approach:**
- `delete_chunks_by_role(self, node_id: str, role: Literal["body", "summary"]) -> None`: predicate `f"node_id = '{_quote(node_id)}' AND role = '{_quote(role)}'"`. The `Literal` type plus a runtime `assert role in ("body", "summary")` closes the future-caller injection footgun (security F3).
- One-line module note explaining when to prefer this over `delete_by_node_id`.

**Patterns to follow:**
- `delete_by_node_id` at lancedb_store.py:190.
- `_quote` helper at line 440.

**Test scenarios:**
- Happy path: write 3 body + 1 summary chunk; `delete_chunks_by_role(node_id, "body")` leaves the summary intact and removes bodies.
- Edge case: node with no chunks of that role → no-op, no error.
- Edge case: chunks for other nodes are unaffected.
- Edge case: SQL-injection-via-node-id (e.g. `"x' OR 1=1; --"`) is escaped by `_quote`; surviving rows are exactly the unrelated nodes.

**Verification:**
- After enhancement runs successfully, summary chunks survive and body chunks reflect advanced output.

---

- [x] **Unit 3: ImageProcessor split + factory assertion**

**Goal:** Replace the monolithic `process` with basic-only + a separate `process_enhancement`. Basic flags for enhancement on success. Folds in the `image-ocr`-must-be-local-paddleocr factory assertion (originally Unit 8).

**Requirements:** R1, R2, R3, R4, R5, R6, R12, brainstorm-deferred R1+R9 edge

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `sidecar/search_sidecar/index/processors/image.py`
- Modify: `sidecar/search_sidecar/index/factory.py` (image-ocr local-paddleocr assertion)
- Modify: `sidecar/tests/test_image_processor.py`
- Modify: `sidecar/tests/test_factory.py`

**Approach:**
- `process(job) -> int` runs ONLY the basic OCR extractor + captioner. Same delete-then-write shape as today, minus advanced. After success, if `self._advanced_ocr_extract is not None` AND the body chunk count > 0 (gate R2), call `self._queue.set_enhancement_pending(job.node_id)`.
- Add `has_advanced_ocr(self) -> bool` returning `self._advanced_ocr_extract is not None`. Used by Unit 4.
- New `process_enhancement(job, claim_seq) -> None`:
  1. Run advanced extractor; catch all exceptions through `_classify_enhancement_error`.
  2. **Transient + attempts < cap:** `self._queue.bump_enhancement_attempts(job.node_id)`; raise `EnhancementTransientError` for the runner.
  3. **Terminal OR cap-exhausted:** `self._queue.mark_enhancement_failed(job.node_id)`; log warn; return cleanly.
  4. **Non-empty raw text:** call `chunk_text(advanced_text)`. If `len(chunks) == 0` (whitespace-only or hallucination), treat as empty (step 5 below).
  5. **Empty after chunking:** `self._queue.clear_enhancement_pending(job.node_id)`; return.
  6. **Non-empty chunks:** `self._store.delete_chunks_by_role(node_id, "body")`; `self._store.upsert(new_body_rows)`. Captions untouched.
  7. **Race re-check:** under `self._queue._lock` (acquire via the helper, do not reach into private state directly), re-read `peek_transition_seq(node_id)`. If `current_seq != claim_seq`: call `self._store.delete_by_node_id(node_id)` (corrective wipe — let the now-pending basic pass rewrite) and return without clearing the flag (the pending row's basic-pass completion will set it again on success). If unchanged: `self._queue.clear_enhancement_pending(job.node_id)`.
- `_classify_enhancement_error(exc) -> Literal["transient", "terminal"]`. Transient: `httpx.TransportError` family, `httpx.ConnectError`, `httpx.ReadTimeout`, `httpx.WriteTimeout`, `asyncio.TimeoutError`, `ConnectionError`, plus `httpx.HTTPStatusError` with `response.status_code in (429, 500, 502, 503, 504)`. **Explicitly terminal:** `httpx.HTTPStatusError` with 401/403, all paddleocr internal errors, all `RuntimeError`s. Default: terminal.
- `EnhancementTransientError(Exception)` defined in this module for the runner to catch.
- **Factory assertion (folded from old Unit 8):** in `factory.select_ocr_extractor`, if `settings.features["image-ocr"].provider_id != "local-paddleocr"`, log a structured error and return `None`. Surface via the existing settings-error channel.

**Execution note:** Implement test-first for `_classify_enhancement_error` and the `process_enhancement` orchestration — branch matrix is small but consequences are persistent.

**Patterns to follow:**
- `_safe_extract` at image.py:186-205.
- Chunk id naming: `f"{node_id}:{i}"` for body, `f"{node_id}:summary:{i}"` for summary.

**Test scenarios** (state-transition-oriented; specific call sequences are implementation detail):
- Basic pass with non-empty body and an advanced extractor present → row ends with `enhancement_pending=1`.
- Basic pass with empty body OR no advanced extractor → row stays `enhancement_pending=0`.
- Enhancement happy path → body chunks replaced, summary chunks survive, row ends with `enhancement_pending=0`, `enhancement_failed=0`.
- Enhancement returns whitespace-only text → after `chunk_text` produces zero chunks, basic chunks remain, row ends with `enhancement_pending=0` (security F5 fix).
- Enhancement returns a single garbage character (`"-"`) that survives `.strip()` but produces zero chunks after chunking → basic chunks remain (security F5 fix).
- Transient error (simulated 429) below cap → row's `enhancement_attempts` increments; flag stays.
- Transient error at cap → row ends with `enhancement_failed=1, enhancement_pending=0`.
- Terminal error (simulated 401) → row ends with `enhancement_failed=1` after exactly one attempt (no retry, security F6).
- Terminal error (simulated paddleocr exception) → same as 401.
- Mid-flight re-enqueue (transition_seq advanced between claim and post-write recheck) → store has been wiped via corrective `delete_by_node_id`; row's `enhancement_pending` is unchanged (will be re-set by the pending row's basic-pass).
- Factory: image-ocr bound to local-paddleocr → returns the rapidocr extractor.
- Factory: image-ocr bound to a cloud provider → returns None and logs the structured error.

**Verification:**
- Captions present after every enhancement code path that touches the store.
- `enhancement_pending` reaches 0 (or flag cleared via `failed=1`) on every code path except mid-flight race (where the basic-pass cycle will re-set it).

---

- [x] **Unit 4: Dispatcher accessor + runner two-tier drain**

**Goal:** Wire the runner to drain pending first, fall back to enhancement, skip enhancement when advanced isn't available (R13). Hold the constructor-change for `ImageProcessor`.

**Requirements:** R7, R13

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `sidecar/search_sidecar/index/dispatch.py`
- Modify: `sidecar/search_sidecar/index/runner.py`
- Modify: `sidecar/search_sidecar/index/processors/image.py` (constructor: `queue: IndexingQueue` parameter)
- Modify: `sidecar/search_sidecar/lifecycle.py` (pass queue into ImageProcessor)
- Modify: `sidecar/tests/test_runner.py`
- Modify: `sidecar/tests/test_dispatcher.py`

**Approach:**
- `Dispatcher` gains a typed attribute `image_processor: ImageProcessor | None` set during `__init__` (find the ImageProcessor in the `_processors` list, store the reference). The Processor Protocol stays unchanged (feasibility F2 fix).
- Runner `_handle()` becomes:
  1. Try `queue.claim_next()` (existing path; preserves `unsupported` mapping and the `mark_indexed`/`mark_error` shape).
  2. If no pending AND `dispatcher.image_processor and dispatcher.image_processor.has_advanced_ocr()`:
     - `result = queue.claim_next_enhancement()`. If None, idle-wait.
     - Otherwise unpack `(job, claim_seq)`; call `dispatcher.image_processor.process_enhancement(job, claim_seq)` directly.
  3. Catch `EnhancementTransientError`: log info, no `mark_error`. Queue's `enhancement_attempts` is the source of record.
  4. Catch other exceptions during enhancement: log warn + call `queue.mark_enhancement_failed(node_id)` (defensive — Unit 3 should have done it; belt-and-braces).
  5. If neither pending nor enhancement work, idle-wait `IDLE_POLL_INTERVAL_SECONDS`.
- `ImageProcessor.__init__` gains `queue: IndexingQueue` parameter (Unit 3 already references it; Unit 4 supplies it through `lifecycle.py`). Keep the dependency injection minimal — no global queue lookup.
- Note: state stays `indexed` during enhancement — Rust's `/index/changes` poller does NOT see a transition (correct per Scope: enhancement state is sidecar-internal).

**Patterns to follow:**
- `process_one`/`_handle` shape at runner.py:82-126.
- Dispatcher constructor at dispatch.py:39-59.
- Lifecycle wiring at lifecycle.py:121-141.

**Test scenarios:**
- Pending + indexed-with-flag → runner processes pending first.
- Only enhancement work AND has_advanced_ocr=True → runner drains enhancement.
- Only enhancement work AND has_advanced_ocr=False → runner sleeps; rows stay flagged (R13).
- Pending arrives mid-enhancement → in-flight enhancement completes; pending picked up next tick.
- `EnhancementTransientError` raised → no `mark_error`, no `mark_enhancement_failed` (queue already bumped attempts).
- Unclassified exception during enhancement → defensive `mark_enhancement_failed` fires.
- Disabling advanced OCR (e.g. a fresh dispatcher with `image_processor=None`) → flagged rows survive, no error rows.

**Verification:**
- Pending arriving while no enhancement is in flight is picked up within `IDLE_POLL_INTERVAL_SECONDS`.

---

- [x] **Unit 5: Backfill IPC + sidecar startup auto-fire**

**Goal:** Expose the idempotent backfill endpoint and trigger it from sidecar startup when advanced is already available (cross-version-upgrade case).

**Requirements:** R10

**Dependencies:** Unit 1, Unit 4

**Files:**
- Modify: `sidecar/search_sidecar/routes/index.py`
- Modify: `sidecar/search_sidecar/lifecycle.py`
- Modify: `sidecar/tests/test_routes_index.py`
- Modify: `sidecar/tests/test_lifecycle.py`

**Approach:**
- Add `POST /index/backfill-enhancement` to `routes/index.py`. Reads queue from request state, takes `IMAGE_EXTENSIONS` constant, calls `queue.backfill_enhancement_pending(IMAGE_EXTENSIONS)`. Returns `{"flagged": int}`. No request body. Bearer auth applies (existing global middleware via `app.add_middleware(BearerAuthMiddleware, ...)` in app.py:51 — covers all `include_router`'d routes).
- New helper `_run_advanced_ocr_backfill_on_boot(queue, dispatcher)` in `lifecycle.py`, mirroring `_run_reembed_sweep`'s shape (lifecycle.py:227-237):
  - If `dispatcher.image_processor and dispatcher.image_processor.has_advanced_ocr()`: call the queue method directly (NOT via HTTP).
  - Wrap the entire body in `try/except Exception as err: log.warning(...)` so a failure here cannot block boot. Log `flagged` count on success.
- `IMAGE_EXTENSIONS`: defined once on `ImageProcessor.SUPPORTED_EXTENSIONS`; imported by `routes/index.py` and the lifecycle hook.

**Patterns to follow:**
- Existing `routes/index.py` shape at line 33.
- Lifecycle bootstrap order at lifecycle.py:121-141; `_run_reembed_sweep` at lines 227-237.

**Test scenarios:**
- Happy path: POST against a queue with 5 indexed images all `enhancement_pending=0, enhancement_failed=0` → `{"flagged": 5}`; second call → `{"flagged": 0}`.
- Edge case: only `kind='file'` AND image extensions get flagged; PDFs and folders don't.
- Edge case: rows with `enhancement_failed=1` are NOT flagged (closes ADV-002 path).
- Edge case: empty queue → `{"flagged": 0}`.
- Integration: sidecar startup with a pre-populated `queue.db` (3 indexed images + advanced available) auto-fires the backfill; log shows count; sidecar comes up healthy.
- Error path: missing bearer token returns 401 (smoke test for this specific route).
- Error path (defensive): startup hook with a queue that raises on UPDATE (simulated DB lock) → boot still succeeds; warning logged.

**Verification:**
- Existing installs with Advanced OCR already available have all their indexed images flagged after the next sidecar startup.

---

- [x] **Unit 6: Diagnostics counter (sidecar + UI)**

**Goal:** Surface `done / total` enhancement counter in Settings → Diagnostics with a separate failed-count signal.

**Requirements:** Origin: Backlog observability

**Dependencies:** Unit 1

**Files:**
- Modify: `sidecar/search_sidecar/routes/index.py` (extend `/status` payload)
- Modify: `sidecar/search_sidecar/index/queue.py` (count helpers)
- Modify: `src/lib/contracts/search.ts` (extend `IndexStatus`)
- Modify: `src-tauri/src/services/search/client.rs` (extend `IndexStatusDto`)
- Modify: `src/features/settings/components/SettingsDiagnostics.tsx` (new cell)
- Modify: `sidecar/tests/test_routes_index.py`

**Approach:**
- Three queue counts (each one SELECT under `_lock`):
  - `count_enhancement_pending()`: `WHERE state='indexed' AND enhancement_pending=1`
  - `count_enhancement_failed()`: `WHERE state='indexed' AND enhancement_failed=1`
  - `count_enhancement_eligible_total()`: count of `state='indexed' AND kind='file' AND <ext>`
- `/index/status` payload extension: `enhancement_pending`, `enhancement_failed`, `enhancement_total_images`. (Three additive numeric fields. Existing fields untouched.)
- Mirror in TS `IndexStatus` and Rust `IndexStatusDto`.
- `SettingsDiagnostics`: fifth cell. State spec (closes design F1+F2+F4):
  - **Loading** (`indexing == null` OR `indexing.state !== "ready"` OR `indexing.data == null`): cell shows label "Image OCR enhancement", value "—", sub-label "loading…", no progress bar. Mirrors the Indexed-items / In-flight loading shape.
  - **Hidden** (`enhancement_total_images === 0` OR no `image_processor.has_advanced_ocr()` indicator from settings): cell does not render. Reason for the second clause: a user who never bound advanced OCR has no reason to see an enhancement counter. Use `models` envelope's role state (any `advanced-ocr-*` role at `state="ready"`) as the proxy; UI fallback if missing.
  - **Active progress** (`pending > 0`): value `${total - pending - failed} / ${total}`; sub-label `${pending} remaining`; full-width bar at `((total - pending - failed) / total) * 100`%. If `failed > 0`, append second sub-line `${failed} failed` styled subtly.
  - **Complete** (`pending === 0`, `total > 0`): value `${total - failed} / ${total}`; sub-label `complete` (or `complete with ${failed} failed` if `failed > 0`); full bar (greyed if all-failed, full if all-success).
- Cell label: "Image OCR enhancement" (clearer than "Image enhancement"; closes design F1).

**Patterns to follow:**
- 4-cell layout in `SettingsDiagnostics.tsx`.
- DTO mirror pattern (TS at `src/lib/contracts/search.ts`, Rust at `client.rs:227-235`).

**Test scenarios:**
- `/index/status` with 10 indexed images (4 pending, 1 failed) → `pending: 4, failed: 1, total: 10`.
- Counter `(total - pending - failed) / total` = `5 / 10` while a "1 failed" sub-line shows.
- Edge case: 0 total images → cell hidden.
- Edge case: 0 pending, 0 failed, 100 total → "100 / 100, complete".
- Edge case: 0 pending, 5 failed, 100 total → "95 / 100, complete with 5 failed".
- Integration: end-to-end queue mutation → /status → React render shows updated counts after the next poll tick.

**Verification:**
- Counter visibly progresses as the runner drains the backlog.

---

- [x] **Unit 7: Watcher repurpose (local-bundle only)**

**Goal:** Replace the watcher's per-image `node-saved` fan-out with a single backfill IPC call. **Cloud-binding triggers are out of scope for v1** (Scope Boundaries) — eliminates the cloud-readiness signal blocker.

**Requirements:** R10 (local path)

**Dependencies:** Unit 5

**Files:**
- Modify: `src-tauri/src/services/search/advanced_ocr_watcher.rs`
- Modify: `src-tauri/src/services/search/client.rs` (add `backfill_advanced_ocr_enhancement`)
- Modify: `src-tauri/src/lib.rs` (drop the now-unused `emitter` arg from the watcher constructor)

**Approach:**
- Add `SearchSidecarClient::backfill_advanced_ocr_enhancement() -> SidecarEnvelope<BackfillResultDto>` that posts to `/index/backfill-enhancement` with empty body. New `BackfillResultDto { flagged: u64 }`.
- Replace `list_image_node_ids` fan-out + `VfsChangeEvent` emit with a single `client.backfill_advanced_ocr_enhancement().await` inside the local-bundle false→true branch. Log `flagged` count on success.
- Keep first-observation-seeds-only semantics (no fire on initial true).
- **No cloud-binding detection in v1.** Cloud users invoke enhancement via the inspector's Reindex action per origin's pre-plan stance.
- Drop the `emitter: VfsEventEmitter` parameter from `run_advanced_ocr_watcher`; update the call site in `src-tauri/src/lib.rs`.
- Auth-failure handling on the IPC: if the response envelope is `Unavailable` AND the underlying status is 401/403 (extract from envelope error string or HTTP status if available), back off for 5 minutes before next attempt; log error. Reuses the existing `ERROR_BACKOFF` constant precedent at advanced_ocr_watcher.rs:38.

**Patterns to follow:**
- Existing `models_status` polling at advanced_ocr_watcher.rs:137-145.
- `post_envelope` shape at client.rs:443-487.
- Existing `last_all_ready: Option<bool>` first-observation seed.

**Test scenarios:**
- Simulated false→true transition for local bundle → fires `backfill_advanced_ocr_enhancement` exactly once; logs flagged count.
- First observation with already-true state → no fire.
- ready→not-ready→ready (e.g., user re-pinning a stage) → fires on the second ready transition.
- Backfill IPC returns `Unavailable` → loop logs warning, continues; no panic.
- Backfill IPC returns `Unavailable` with auth-failure detail → loop applies extended backoff before the next tick.

**Verification:**
- Enabling Advanced OCR (local download completes) results in exactly one backfill IPC call within the next 10 s tick.
- Cloud-bound advanced OCR does NOT auto-trigger backfill (intentional v1 limitation).

## System-Wide Impact

- **Interaction graph:** Watcher (Rust, local-only trigger) → backfill IPC (HTTP) → IndexingQueue. Runner → Dispatcher.image_processor → ImageProcessor → LanceDBStore. ImageProcessor → IndexingQueue (constructor wiring). No new threads.
- **Error propagation:** Transient enhancement errors stay inside the queue (`enhancement_attempts++`); never reach `jobs.last_error`. Terminal enhancement errors set `enhancement_failed=1` silently in the row (no `last_error` write); Diagnostics counter surfaces the count. Backfill IPC failures log but don't crash the watcher.
- **State lifecycle risks:** Mid-enhancement re-enqueue race handled via `transition_seq` re-check AFTER lance write under queue lock + corrective `delete_by_node_id` on mismatch (ADV-001 fix). Disabling advanced OCR mid-drain leaves flags set (resumable); cap-exhausted rows stay terminal until reindexed (ADV-002 fix).
- **API surface parity:** `/index/status` extension is additive (three new fields). `/index/changes` payload unchanged — enhancement work doesn't touch `state` or `transition_seq`. Rust `IndexStatusDto` mirrored.
- **Integration coverage:** End-to-end test: enqueue an image, runner drains, backfill flags, runner enhances, role-aware delete preserves the summary chunk. Mid-flight re-enqueue test covers ADV-001 corrective wipe.
- **Unchanged invariants:** Existing UI explorer state (`indexed` after basic) doesn't change. `attempts` column on `jobs` and its relationship to the basic-pass retry continue unchanged. The brainstorm-deferred "image-ocr cloud" edge is now factory-asserted, closing it definitively.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LanceDB compound predicate `node_id = '...' AND role = '...'` doesn't behave as expected | Verified against `retrieval/filters.py:89` (existing AND-joined predicates). Unit 2 happy-path test verifies role-isolation directly. |
| Mid-flight re-enqueue clobbers fresh basic chunks with stale advanced output (ADV-001) | Re-check `transition_seq` AFTER lance write under queue lock; on mismatch, corrective `delete_by_node_id` lets the now-pending basic pass rewrite cleanly. |
| Cap-exhausted row gets re-flagged by next backfill IPC (ADV-002) | Sticky `enhancement_failed=1` sentinel in the backfill predicate. Only `enqueue` (file mod) or `Reindex` (R12) clears it. |
| 50k-image library at 5-15s/image = 70-200 hours of sustained single-thread CPU (product F1) | Documented limitation. v1 ships without throttling/AC-only/time-window; if device-UX feedback warrants, follow-up plan can add the rate-limit knob without touching this plan's data model. The Diagnostics counter gives the user visibility into progress. |
| Cloud egress cost surprise on first cloud-binding (security F4) | Cloud auto-backfill is **out of scope for v1** (Scope Boundaries). Cloud users use Reindex per-node. Bulk cloud backfill is a separate plan that must integrate with the existing CloudEgressConsentDialog. |
| PP-StructureV3 emits HTML tables that the chunker may slice mid-element, degrading the "search tables" headline use case (product F8) | Tracked separately as the chunker HTML-boundary issue (origin Dependencies). v1 of two-pass ships the mechanism; chunker quality is a follow-up plan. The advanced text is at worst "no worse than basic" because of the empty-after-chunking gate; it cannot be empirically worse than skipping enhancement. |
| `_classify_enhancement_error` misclassifies a paddleocr exception as terminal when it could recover | Conservative default (terminal) avoids retry storms. Unclassified exceptions are logged with full stack so we can tighten the classifier as patterns surface. |
| Diagnostics counter conflates "successfully enhanced" with "gave up" if `enhancement_failed` isn't surfaced separately | The cell renders pending/done AND failed counts (Unit 6). The "complete with N failed" sub-label is the user-visible signal. Without `enhancement_failed`, the counter would always reach 100% and silently mask quality problems (product F3). |
| Silent terminal failures with no error trail (product F4) | `enhancement_failed=1` rows are visible in the Diagnostics counter; sidecar logs include the full stack trace at warn level. UI-level toast on systemic failure rate is deferred to a follow-up. |
| Caption staleness post-enhancement (product F5; origin R4) | Accepted v1 limit. Captions are produced once in the basic pass; advanced OCR may produce body text that contradicts the caption. The brainstorm explicitly accepts this. Audit of caption surfaces (ExplorerInspector, ImagePreview) before launch confirms the staleness is invisible to the user; if not, file a follow-up. |
| Long-running backfill on existing 50k library spikes queue write contention | Backfill is a single SQL UPDATE; completes in milliseconds. The runner picks up the work over hours/days at its natural pace. |
| Sidecar bearer token rotates between Rust client cache and the new backfill IPC | Watcher applies extended backoff on auth-failure response (Unit 7). Existing `post_envelope` rendezvous with the supervisor's runtime file refreshes the token on next reload. |

## Documentation / Operational Notes

- Update `sidecar/README.md` if the schema section exists: mention the three new columns. One sentence.
- No frontend docs change for the Diagnostics card itself, but a single-line entry in CHANGELOG (or equivalent release notes) helps users notice the new counter.
- No migration script needed — idempotent `ALTER TABLE ADD COLUMN` runs at sidecar startup. Existing installs with Advanced OCR enabled get one-shot backfill on first boot after upgrade.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-03-two-pass-image-ocr-requirements.md](../brainstorms/2026-05-03-two-pass-image-ocr-requirements.md)
- Related plans: [docs/plans/2026-05-02-001-refactor-chunk-role-schema-plan.md](2026-05-02-001-refactor-chunk-role-schema-plan.md), [docs/plans/2026-04-26-004-feat-cross-workspace-search-plan.md](2026-04-26-004-feat-cross-workspace-search-plan.md), [docs/plans/2026-05-02-002-feat-feature-oriented-settings-plan.md](2026-05-02-002-feat-feature-oriented-settings-plan.md)
- Related code: [sidecar/search_sidecar/index/queue.py](../../sidecar/search_sidecar/index/queue.py), [sidecar/search_sidecar/index/processors/image.py](../../sidecar/search_sidecar/index/processors/image.py), [src-tauri/src/services/search/advanced_ocr_watcher.rs](../../src-tauri/src/services/search/advanced_ocr_watcher.rs)
