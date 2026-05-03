---
date: 2026-05-03
topic: two-pass-image-ocr
---

# Two-Pass Image OCR

## Problem Frame

Cognios indexes mounted images via OCR so they're searchable. Two extractors are wired:

- **Basic OCR** (`local-paddleocr` → rapidocr-onnxruntime). Fast, ~100-400 ms per image. Returns flat text. Unreliable on receipts, invoices, tables, formulas.
- **Advanced OCR** (`local-paddleocr-advanced` → PP-StructureV3, or cloud structured-prompt vision). Slow, ~5-15 s per image on CPU. Returns Markdown with GFM tables and LaTeX math.

Today, when Advanced OCR is enabled, `ImageProcessor` runs advanced first and basic only as a fallback when advanced returns empty. For a 10k-image library that's potentially many hours of indexing where most of the cost falls on photos that don't need layout-aware extraction. Users can't search anything until the slow pass is done.

This brainstorm scopes a two-pass design: every image gets a fast basic pass first (immediately searchable), and Advanced OCR runs opportunistically in the background to enhance the body chunks. Users see results fast and quality compounds without their attention.

## Terminology

- **Body chunks** — `role="body"` rows in the lancedb chunk store. Plain-text OCR (basic) or Markdown (advanced) gets written here. Searchable.
- **Summary chunks** — `role="summary"` rows. Image captions. Orthogonal to body.
- **Basic pass** — invocation of `ImageProcessor.process(job)` that runs the basic OCR extractor (`local-paddleocr`) and the captioner. Writes both `body` and `summary` chunks.
- **Enhancement pass** — invocation of a new `ImageProcessor.process_enhancement(job)` (or equivalent) that runs the advanced OCR extractor and replaces only `body` chunks. Summary chunks are untouched.
- **Chunker** — `chunking.chunk_text(...)`, the existing utility that splits a string into bounded text chunks. Ingests both flat text and Markdown.

## Requirements

**Indexing flow**
- R1. When `image-ocr` is bound, `ImageProcessor.process` runs the basic OCR extractor and (if wired) the captioner. The node transitions to `indexed` as soon as the basic chunks are written.
- R2. After a successful basic pass, the node is flagged for enhancement when an advanced extractor is wired AND the basic pass produced a non-empty body. The flag is a new column on the existing `jobs` table (see Key Decisions).
- R3. A separate enhancement pass runs Advanced OCR on flagged nodes via `ImageProcessor.process_enhancement(job)`. The pass extracts first, then — only on non-empty advanced output — deletes the existing body-role chunks for that node and writes the advanced body chunks. Summary (caption) chunks are never touched by the enhancement path. Requires a role-aware delete on `LanceDBStore` (e.g., `delete_chunks(node_id, role="body")`); confirmed feasible by lancedb's predicate language (the store already calls `delete(f"node_id = '...'")` and `delete(f"id IN (...)")`).
- R4. Caption (summary) chunks are produced once during the basic pass and are NOT re-run during enhancement — captioning is a separate axis with its own cost (cloud API call) that doesn't benefit from advanced layout extraction. Accepted v1 limit: a caption may describe content that's been since upgraded by advanced OCR; the staleness is a known tradeoff, not a bug.
- R5. If Advanced OCR returns empty during enhancement, the existing basic body chunks stay untouched (the enhancement path doesn't pre-delete); the flag is cleared. Empty advanced output is treated as "no improvement available", not a retry condition.
- R6. Enhancement failures are split into **transient** vs **terminal**. Transient (network error, HTTP 429/5xx, timeout, request error) → retry with bounded attempts and exponential backoff; the flag stays set. Terminal (decode error, 4xx-non-429, paddleocr internal error, unsupported format) → clear the flag, basic chunks untouched. A new `enhancement_attempts INTEGER NOT NULL DEFAULT 0` column on `jobs` tracks consecutive transient retries; capped at 3. After cap exhausted, the failure is treated as terminal. The mid-enhancement file-modification race deferred to planning still applies on top of this.

**Scheduling**
- R7. The single indexing worker drains regular pending jobs first; enhancement jobs are claimed only when no pending job is available. A fresh file modification interrupts the enhancement backlog at the next tick boundary.
- R8. Enhancement work survives sidecar restart — the flag is persisted in the same SQLite store as the queue, not held in memory.

**Cloud OCR**
- R9. The same flow applies when Advanced OCR is bound to a cloud provider (OpenAI / Qwen DashScope vision). Basic local OCR runs first; cloud advanced OCR runs as enhancement. (Even though cloud advanced is "faster" per call than local PP-StructureV3, the two-pass model still gives users immediate results and bounds API egress to a background trickle.)

**Backfill on first enable**
- R10. When the Advanced OCR bundle becomes available (local: all 13 PP-StructureV3 stages reach `ready`; cloud: provider key + capability bound), every existing image node is flagged for enhancement so the existing library progressively upgrades. **Mechanism:** the existing [advanced_ocr_watcher.rs](src-tauri/src/services/search/advanced_ocr_watcher.rs) is repurposed — instead of emitting `node-saved` (which would re-run the basic pass for no reason), it calls a new sidecar IPC that flips `enhancement_pending=1` on every image node already in `state='indexed'`. The cloud path adds a parallel trigger: when settings binding for a `*-vision` capability transitions unbound→bound AND the provider key is present, the same backfill IPC fires. The mechanism is **not** an atomic settings PUT — settings live in the sidecar's `settings.json`, but the authoritative `jobs`/`nodes` tables live in the sidecar's index DB and Rust's `cognios.db` respectively, so cross-process atomicity is not possible. The backfill IPC is idempotent (idempotency = "set bit on rows where it isn't already set") so a re-trigger is safe.

**Re-indexing semantics**
- R11. A file modification (re-enqueue) re-runs the full two-pass flow: basic → indexed → enhancement-flagged → advanced → flag cleared. On re-enqueue (`ON CONFLICT(node_id) DO UPDATE` path in `IndexingQueue.enqueue`), the enhancement flag is reset to 0; the basic-pass completion handler re-sets it on success when an advanced extractor is wired.
- R12. The user-triggered Reindex action in the existing `ExplorerInspector` (already implemented; see [src/features/explorer/components/ExplorerInspector.tsx]) triggers the same flow as R11. R12 is a behavioural spec for an existing button; not new UI scope.
- R13. When Advanced OCR is later disabled, any enhancement-pending flag is left as-is. The runner detects "advanced extractor is unwired" by checking the dispatcher state before peeking the enhancement tier; if unwired, the enhancement tier is skipped entirely (no claim, no error mark) and the loop falls through to idle wait. Re-enabling resumes the backlog.

## Success Criteria

- New images become searchable within seconds of arriving in a watched mount, regardless of whether Advanced OCR is enabled.
- With Advanced OCR enabled, images progressively upgrade to layout-aware text without user intervention; the user can quote tables and formulas in search after the enhancement pass completes.
- Indexing a library of 10k images doesn't block the queue: a stream of new files always wins priority over the long enhancement backlog.
- Enabling Advanced OCR for the first time does not lose the user's existing index — every image is at least at "basic OCR" quality throughout the upgrade.

## Scope Boundaries

- **No layout pre-classifier.** We don't try to detect "this image looks document-like" before deciding which extractor to run. Both extractors run on every image (sequentially, in two passes) when Advanced OCR is enabled. A heuristic gate is deliberately out of scope.
- **No per-folder opt-in.** The user explicitly rejected per-mount/per-folder controls. Two-pass behavior is global when Advanced OCR is enabled.
- **No exposure of "enhancement pending" in the UI.** From the user's perspective, the node is `indexed` once basic chunks land. The internal flag is for the runner only; the explorer doesn't surface a separate state.
- **No retry on enhancement failure.** Best-effort. Basic chunks are good enough.
- **Captioning is unchanged.** Image captioning runs once in the basic pass and isn't re-touched during enhancement.
- **No multi-worker pool.** Single indexing thread, two-tier draining. Parallel enhancement workers are deferred.

## Key Decisions

- **Basic always runs first; advanced enhances later.** Mirrors the user's stated UX: "use normal ocr first and mark it as reindex needed and use advance ocr to enhance it". Maximises perceived responsiveness; quality compounds opportunistically.
- **Backfill every existing image when the Advanced OCR bundle becomes ready.** User explicitly chose this over "only forward" or "user-triggered button". Comprehensive coverage > predictable cost.
- **Backfill mechanism = repurpose the existing watcher.** [advanced_ocr_watcher.rs](src-tauri/src/services/search/advanced_ocr_watcher.rs) already detects the false→true transition for local advanced-OCR readiness; it changes semantics from "emit `node-saved` per image" (which would re-run basic) to "call a sidecar backfill IPC that flips `enhancement_pending=1` on indexed image nodes". A parallel cloud-side trigger fires when a `*-vision` capability transitions unbound→bound. The mechanism is **idempotent** so a re-trigger is safe. (Selected over the alternatives "settings-PUT-driven backfill" — would have required a second mechanism for the local-bundle-ready signal — and "two parallel mechanisms" — duplicated logic.)
- **Enhancement flag = two columns on `jobs`.** `enhancement_pending INTEGER NOT NULL DEFAULT 0` (single-bit flag) and `enhancement_attempts INTEGER NOT NULL DEFAULT 0` (transient-retry counter). Runner's `claim_next_enhancement` queries `WHERE state='indexed' AND enhancement_pending=1`. The `enqueue` upsert resets both columns to 0 (R11). Migration follows the same `ALTER TABLE ADD COLUMN` pattern as `transition_seq`. Cheaper than introducing a parallel store; reuses the queue's transition / persistence machinery.
- **Retry policy: distinguish transient vs terminal enhancement failures.** Transient (network error, HTTP 429/5xx, timeout, connection drop) → bounded retry with backoff, flag stays set, `enhancement_attempts++`. Terminal (decode error, 4xx-non-429, paddleocr error, unsupported format) → clear flag, basic stays. Attempts capped at 3; after cap exhausted, treat as terminal. (Selected over "no retry / silent" because a single 429 shouldn't permanently downgrade an image; selected over "retry-everything" because terminal errors don't get better with retry.)
- **Backlog observability = single Settings → Diagnostics counter.** "X / Y images enhanced" line in the existing Diagnostics panel; no per-node UI exposure. Honours Scope Boundaries' "no enhancement-pending UI" while giving the user a way to know whether the backlog is making progress. (Selected over "silent multi-day backfill with no signal" — too opaque — and over "rate-limit / time-window the backfill" — premature optimisation; ship the baseline first.)
- **Captions only run in the basic pass.** Captions are summary chunks — orthogonal to OCR text. Re-running them during enhancement would double-bill the cloud caption API for no quality gain.
- **Pre-classifier deferred.** A cheap layout-only pass to triage which images need advanced OCR (e.g., reject family photos before paying the 5-15 s cost) was considered and dropped. Rationale: every basic-OCR'd image is already searchable, so the question is purely "is the marginal compute spent on a non-document image wasted." User explicitly preferred comprehensive enhancement over a heuristic gate that might miss edge cases (a handheld photo of a receipt looks like a regular photo).
- **Per-folder opt-in deferred.** A "tag this mount as documents" UI was considered. Rationale: adds a config surface the user explicitly rejected ("don't let user decide"). Per-folder routing can be reintroduced later as a refinement on top of the universal two-pass flow without re-architecting.

## Dependencies / Assumptions

- The chunker (`chunking.chunk_text`) can ingest the Markdown output from Advanced OCR as a single string; tables and formulas embed as text. (Already true today; ImagePreview re-renders Markdown.) **Note:** for content with embedded HTML tables (PaddleOCR's PP-StructureV3 default), the chunker may slice through HTML element boundaries. Tracked as a separate quality issue, not blocking for this brainstorm.
- LanceDB supports filtered delete by `(node_id, role)`. Verified by reading [sidecar/.../storage/lancedb_store.py] — the store already issues `delete(f"node_id = '...'")` and `delete(f"id IN (...)")` against lancedb's expression language; a compound predicate is the same shape. The role-aware delete *method* doesn't exist on `LanceDBStore` yet and is part of R3's required additions.
- The single indexing thread today doesn't compose surprisingly with the new "drain pending then peek enhancement" loop. (Plain extension of the existing `process_one` loop.)
- R7's "next tick boundary" interrupt for fresh pending jobs is bounded by `max(in_flight_enhancement_duration)` — single-thread runner can only check the queue between completed jobs. With advanced OCR at 5-15 s/image on CPU, worst-case latency for a fresh file is bounded by that duration, not by the runner's `IDLE_POLL_INTERVAL_SECONDS = 0.5`.

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] Should the two-tier drain re-check the pending queue between every enhancement, or batch a few enhancements before the next pending check? Affects latency-vs-throughput trade-off for new files arriving during a long backlog.
- [Affects R3][Technical] Mid-enhancement file-modification race. If an enhancement is in flight on node X and the file is modified at t=mid, R11 re-enqueues basic — but the in-flight advanced commit may still land afterward, clobbering the freshly-written basic chunks of NEW content with advanced output derived from OLD content. Need cancellation semantics: tag the enhancement claim with a content_hash or job_seq, abort the commit if the node has been re-enqueued since claim time.
- [Affects R8][Technical] Schema migration for cross-version upgrades. If a user already has Advanced OCR enabled before the upgrade, the new column defaults to 0 and the R10 watcher won't re-fire (because models were already ready). Decision: detect "advanced was already on at upgrade time" and one-shot backfill, OR document explicitly that pre-upgrade images stay basic-only until reindexed.
- [Affects R1+R9][Technical] Edge case: `image-ocr` bound to a cloud provider (currently allowed by the preset matrix even though the default is local-paddleocr). The two-pass model degenerates to two sequential cloud calls per image. v1 stance: image-ocr stays mandatory + local-paddleocr-default; assert this in the factory and surface an error if a user manually rebinds image-ocr to cloud.

## Next Steps

`-> /ce:plan` — all blocking product decisions resolved; planning can proceed.
