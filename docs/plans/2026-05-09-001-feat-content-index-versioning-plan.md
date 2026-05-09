---
status: completed
created: 2026-05-09
origin: direct-request
---

# Content Index Versioning Plan

## Problem

The search index currently treats a node's queue state as a single truth for both lightweight metadata and expensive content work. That causes two bad outcomes:

- Metadata-only events, especially rename/resync duplicates, can reset an already indexed row to `pending` even when LanceDB already has content chunks.
- Slow OCR and advanced-OCR work can complete after a file changes unless the queue has an explicit way to tie the result to the content version it processed.

The system needs a version boundary between node metadata, base content indexing, and enhancement indexing.

## Scope

In scope:

- Add a sidecar-owned `content_version` for indexable node events.
- Track which content version has been indexed by the queue.
- Store `content_version` on LanceDB chunks.
- Make startup/resync and rename metadata updates avoid resetting content indexing when the content version is unchanged.
- Make advanced OCR check the claimed content version before replacing body chunks.

Out of scope:

- A Rust `nodes` table migration for content versions.
- A cryptographic full-file hash for every file.
- UI changes beyond fixing state consistency.
- Reworking search result ranking or retrieval.

## Key Decisions

- **Sidecar computes content version.** The sidecar sees `absolute_content_path`, so it can derive a cheap version from file metadata without adding Rust DB columns.
- **Cheap fingerprint first.** Version format starts as file stat: size plus nanosecond mtime. If the file is unavailable, fall back to the event's modified timestamp.
- **Metadata updates are non-forcing.** Startup resync and `node-renamed` update metadata but do not force content re-index when the content version is unchanged.
- **Manual/user content actions remain forcing.** `node-saved`, `url-indexed`, user reindex, and genuinely newer file content still enqueue content work.
- **Enhancement is tied to content version.** Advanced OCR only writes if the queue row still matches the version it claimed.

## Implementation Units

- [x] **Unit 1: Version the Sidecar Queue**

**Goal:** Add `content_version` and `indexed_content_version` to the persistent queue and use them to decide whether enqueue should reset state.

**Files:**
- Modify: `sidecar/search_sidecar/index/queue.py`
- Test: `sidecar/tests/test_index_queue.py`

**Approach:**
- Add queue columns with additive migrations.
- Extend `IndexingJob` with `content_version`.
- Compute a version during `enqueue` from `absolute_content_path` stat metadata, falling back to `modified_at`.
- Keep existing default `force=True` behavior.
- For `force=False`, update metadata fields but skip resetting state when the row already has the same or newer `content_version` and is pending/indexing/indexed.
- Set `indexed_content_version = content_version` in `mark_indexed`.

**Test scenarios:**
- Existing indexed row with same `content_version` plus `force=False` remains indexed and does not bump transition seq.
- Existing indexed row with newer `content_version` plus `force=False` becomes pending.
- Forced enqueue with same `content_version` still revives to pending for manual reindex.
- Schema migration preserves legacy queue rows with nullable versions.

**Execution note:** Test-first around same-version enqueue because this is the bug seen after first mount.

- [x] **Unit 2: Store Content Version in LanceDB and Update Metadata Separately**

**Goal:** Persist content version on chunks and allow metadata-only updates without deleting/recreating content chunks.

**Files:**
- Modify: `sidecar/search_sidecar/storage/lancedb_store.py`
- Modify: `sidecar/search_sidecar/index/processors/text.py`
- Modify: `sidecar/search_sidecar/index/processors/pdf.py`
- Modify: `sidecar/search_sidecar/index/processors/url_cache.py`
- Modify: `sidecar/search_sidecar/index/processors/image.py`
- Test: `sidecar/tests/test_lancedb_store.py`
- Test: existing processor tests under `sidecar/tests/`

**Approach:**
- Add nullable `content_version` to the LanceDB schema and migration.
- Add `content_version` to `NodeChunk`.
- Have processors write `job.content_version` into every chunk row.
- Add a metadata update helper that rewrites existing rows for a node with new `kind`, `name`, `mount_id`, and `modified_at` while preserving text/vector/content version.

**Test scenarios:**
- New chunks include `content_version`.
- Legacy LanceDB table opens with a nullable `content_version` column.
- Metadata update changes `name` without changing `text`, `vector`, or row count.

- [x] **Unit 3: Extend Event Contract for Metadata-Only Flows**

**Goal:** Let Rust tell the sidecar which node events are forcing content work and which are metadata/resync updates.

**Files:**
- Modify: `src-tauri/src/services/search/client.rs`
- Modify: `src-tauri/src/services/search/forwarder.rs`
- Modify: `sidecar/search_sidecar/routes/events.py`
- Test: `src-tauri/src/services/search/client.rs`
- Test: `sidecar/tests/test_index_routes.py`

**Approach:**
- Keep `force` optional in the Rust/Python `NodeEvent` payload, defaulting to true for compatibility.
- Mark startup `resync_all_nodes` forwards as `force=false`.
- Mark `node-renamed` payloads as `force=false`.
- In the sidecar route, update LanceDB metadata for existing chunks before/after queue enqueue, and pass `force` into `IndexingQueue.enqueue`.

**Test scenarios:**
- `force=false` duplicate event for an indexed row keeps queue state indexed.
- Rust serialization emits `force` only when explicitly set.
- `node-renamed` payload has `force=false`; `node-saved` does not.

- [x] **Unit 4: Guard Advanced OCR by Content Version**

**Goal:** Prevent old advanced-OCR work from replacing body chunks if the file changed while enhancement was running.

**Files:**
- Modify: `sidecar/search_sidecar/index/queue.py`
- Modify: `sidecar/search_sidecar/index/processors/image.py`
- Test: `sidecar/tests/test_index_processors_image.py`
- Test: `sidecar/tests/test_index_queue.py`

**Approach:**
- Add a queue helper that checks whether a node still has the claimed `content_version` and transition seq.
- Before advanced OCR deletes/replaces body chunks, verify the claimed version is still current.
- Keep the post-write transition check when clearing enhancement pending.

**Test scenarios:**
- If content is re-enqueued during advanced OCR extraction, the stale enhancement does not replace body chunks.
- If no content change happens, advanced OCR still replaces body chunks and clears enhancement pending.

## Verification

- `cd sidecar && uv run pytest tests -q`
- `cd src-tauri && cargo test`
- `npm run build` if TypeScript contracts change beyond Rust serialization tests.
- `git diff --check`

## Risks

- Cheap file metadata fingerprints can miss content changes when mtime/size are preserved. This is acceptable for now; full hashing can be added later for suspicious or user-triggered reindex paths.
- LanceDB metadata update is implemented as scan-and-replace for a node. That is acceptable because metadata-only updates are per-node and chunk counts are small.
- Legacy queue/index rows have null content versions. First real enqueue should populate the new fields.
