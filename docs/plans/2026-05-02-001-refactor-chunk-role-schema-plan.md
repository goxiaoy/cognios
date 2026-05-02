---
title: Chunk Role Schema — Body vs Summary
type: refactor
status: active
date: 2026-05-02
origin: docs/brainstorms/2026-05-02-chunk-role-schema-requirements.md
---

# Chunk Role Schema — Body vs Summary

## Overview

Replace the stringly-typed `"OCR: …\n\nCaption: …"` prefix convention in the lancedb chunk store with a structured `role` column. Image OCR text becomes `role=body` (chunked normally) and image captions become `role=summary` (single row). All other processors continue producing `role=body` chunks. The schema slot for `role=summary` is reserved for future document summaries (D6 in origin) but the generation pipeline is explicitly out of scope here.

The change is primarily structural — most of its value is unblocking future summary work and cleaning up the frontend's prefix-parsing heuristic. Today's image data is near-zero (OCR/caption extractors are not wired), so the search-contamination problem the origin doc names is mostly theoretical right now; nonetheless this is the right shape to commit before any real image data accumulates.

## Problem Frame

Today's lancedb chunk store has no field describing what kind of content a chunk holds. ImageProcessor encodes that as a string prefix (`"OCR: …\n\nCaption: …"`) baked into the chunk text and concatenates both pieces before chunking. Two consequences flow from this (see origin: `docs/brainstorms/2026-05-02-chunk-role-schema-requirements.md`):

1. **Search contamination.** The literal terms `OCR:` and `Caption:` are part of every image's chunk text. Once images contain real data, queries for `ocr` or `caption` will match every indexed image — false-positive flood.
2. **Conceptual conflation.** OCR text (literal content) and caption (generated description) are different modalities being merged into one row, with the frontend reverse-parsing them via regex (`parseSections` in `src/features/explorer/components/ImagePreview.tsx`).

The same shape — non-body content attached to a node — will recur for document summaries, URL distillations, and (eventually) audio transcripts. The index needs to model that explicitly rather than smuggle it through prefixes.

## Requirements Trace

- **R1.** Add a `role` column to the lancedb chunk schema with values `body` and `summary`. (D1 in origin)
- **R2.** ImageProcessor writes OCR as `role=body` rows (chunked) and caption as a single `role=summary` row. No `OCR:` / `Caption:` prefixes in indexed text. (D2)
- **R3.** Existing TextProcessor / PdfProcessor / URLCacheProcessor produce `role=body` chunks (no behaviour change beyond explicit tagging). (D3)
- **R4.** Search treats every role as searchable; no role weighting in v1. Per-role filtering is out of scope. (D4)
- **R5.** `/index/node/{id}/content` exposes `role` per chunk. ImagePreview filters by role instead of regex-parsing prefixes; `parseSections` is removed. (D5)
- **R6.** Adding a future `role=summary` for documents requires only writing new rows — no further schema migration. (D6)
- **R7.** For nodes indexed under the new schema, searching the literal terms `ocr` or `caption` returns only nodes whose content actually contains those words — never matches an image just because the system stored those terms as prefixes. (Origin Success Criterion 1, scoped to new schema)

## Scope Boundaries

- **Out of scope:** Document summary generation pipeline (PDF / notes / URLs). Schema slot reserved; generation deferred.
- **Out of scope:** Per-role search filters (e.g. `role:summary oauth` inline syntax).
- **Out of scope:** Role-aware ranking (no score boost/penalty for caption vs body hits in v1).
- **Out of scope:** One-shot rewrite of pre-schema image rows. Legacy rows keep their string prefixes until natural reindex; the user accepts temporary cosmetic weirdness (origin Migration section).
- **Out of scope:** Adding a structured `role` filter to the inline query syntax. The orchestrator's per-node max-score aggregation handles dedup naturally.

## Context & Research

### Relevant Code and Patterns

- `sidecar/search_sidecar/storage/lancedb_store.py` — current `nodes` table schema, `NodeChunk` dataclass, `open_store()` open-or-create-with-schema flow, `_chunk_index_key`-style sorting.
- `sidecar/search_sidecar/index/processors/image.py` — current `_build_document()` that emits `"OCR: …\n\nCaption: …"`. ImageProcessor's two extractor injection points (`ocr_extract`, `caption_extract`) stay unchanged; only the row-shape they feed changes.
- `sidecar/search_sidecar/index/processors/{text,pdf,url_cache}.py` — current `role`-implicit body-only writers; will gain explicit `role="body"` argument.
- `sidecar/search_sidecar/routes/index.py` — `/index/node/{id}/content` endpoint and the `_chunk_index_key` sort helper (will gain summary-last semantics).
- `sidecar/search_sidecar/embeddings/reembed.py` — `find_stale_chunks` / `replace_rows` already round-trip every column via `to_pylist`; the role column rides through unchanged. Verify with test, no logic change needed.
- `src-tauri/src/services/search/client.rs` — `NodeContentChunkDto` shape; gains a `role` field with the existing snake_case ↔ camelCase serde split-form convention.
- `src/features/explorer/components/ImagePreview.tsx` — current `parseSections(joined)` regex helper; will be deleted in favour of role-filtered chunks.

### Institutional Learnings

- The `node-deleted` cascade fix (commit `ca0de87`) showed how `VfsChangeEvent` cleanly carries optional descendant lists with `#[serde(default, skip_serializing_if = "Vec::is_empty")]`. Applying the same default-on-deserialize pattern lets the new `role` column read pre-schema rows without crashing.
- The `decode: error decoding response body` incident (search summary, before commit `ed3e997`) drove the snake_case ↔ camelCase split-form. New DTO additions (`NodeContentChunkDto.role`) must use the same `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]` convention; round-trip test required.
- `merge_insert` in lancedb 0.30 was unstable on macOS arm64 ("Spill has sent an error"); the codebase uses delete-then-add. The schema migration must follow the same pattern — no merge_insert.

### External References

None — lancedb behavior known from local work, no security/payments surface, no third-party APIs.

## Key Technical Decisions

- **Schema migration mechanism: `add_columns()` on open.** lancedb 0.30 supports `table.add_columns(pa.field("role", pa.string()))` to add a nullable column to an existing table without rebuild. `open_store()` introspects the opened table's schema; if `role` is missing, calls `add_columns` once. Avoids a one-shot table rebuild + schema-version sentinel and keeps existing rows in place. New writes always supply the column. *Resolves document-review F1.*

- **Summary chunk id format: `<node_id>:summary:<int>`** (e.g. `<node_id>:summary:0`, `<node_id>:summary:1`). Multiple summary rows per node are allowed; summary text is fed through `chunk_text(...)` exactly like body text. Distinct from numeric body indices `<node_id>:<int>`. The `delete_by_node_id` predicate already queries on the `node_id` column so id format is free; uniqueness across body+summary is preserved. The chunk-id sort helper (`_chunk_index_key`) reads the `role` column directly (via `_role_or_default`) and returns a `(category, idx)` tuple where category 0 = body, 1 = summary — body sorts before summary, both sorted by their numeric chunk index. *Resolves document-review F2.*

- **Role nullability + read-side defaulting via single helper.** Schema column is nullable. A single `_role_or_default(row) -> str` helper in `lancedb_store.py` coalesces missing/null to `"body"` and is the only function that reads the column. Every other consumer (orchestrator, routes, frontend) goes through this helper. Eliminates the "every reader must coalesce" risk. *Resolves document-review C3 + A2.*

- **Role enum semantics: rendering / retrieval slot.** `role` describes what kind of chunk this is for the UI/retrieval layer. Future audio transcripts are `role=body` (literal content); an audio summary would be `role=summary`. Modality information (if ever needed) goes in a separate column, not `role`. The named `transcript` example in origin D1 is dropped from the v1 vocabulary to avoid axis confusion. *Resolves document-review P2.*

- **`joined` ordering: body-first, summary appended.** The endpoint's `joined` field concatenates body chunks in chunk-index order, then appends the summary row's text after a `\n\n` separator. Single rule, deterministic, backwards-compatible for the (currently single) frontend consumer. *Resolves document-review F5.*

- **Snippet-selection ranking under mixed roles: defer.** v1 keeps the existing max-score-per-node aggregation untouched. Once document summaries land (D6), BM25 length-normalization will likely make short summary rows over-score relative to bodies; the right time to add a snippet-prefer-body rule or role weighting is when there's real corpus to measure against, not now. Plan note carries this forward. *Resolves document-review F4 + P3 + A3.*

- **Summaries chunk through the standard chunker.** Summary text feeds through `chunk_text(...)` exactly like body text — one `NodeChunk` per chunk, `role="summary"`, id `<node_id>:summary:<int>`. Today's image captions fit in a single chunk (typical VLM caption 50-200 chars vs 512-char cap), but the schema can absorb longer future summaries (D6) without further migration. The single-row simplification considered initially was rejected to avoid a hidden truncation contract. *Resolves document-review A6.*

- **Role validation: application-level, not Pydantic Literal.** The set `{"body", "summary"}` lives as a constant in `lancedb_store.py` and processors must use it. Adding a future role is a code change, not a schema migration. *Resolves document-review A8.*

## Open Questions

### Resolved During Planning

- **Schema migration mechanism** — `add_columns()` on open (see Key Decisions).
- **Chunk-id format for summaries** — `<node_id>:summary` (see Key Decisions).
- **Role nullability** — nullable column, read-side default via single helper (see Key Decisions).
- **Role enum axis** — rendering/retrieval slot only; modality is a separate concern (see Key Decisions).
- **`joined` ordering with mixed roles** — body-first, summary appended (see Key Decisions).

### Deferred to Implementation

- **Whether `add_columns` raises or no-ops** when the column already exists. Implementation should wrap in try/except and treat AlreadyExists as success.
- **Exact NodeChunk default** — `role: str = "body"` as a field default vs required field. Field default is simpler; verify dataclass round-trip through `to_arrow_dict()`.
- **Whether the lancedb FTS index needs rebuilding** when columns change. The existing `ensure_fts_index()` is per-process-cached; first FTS query after schema change naturally triggers a rebuild via the existing `replace=True` semantics. Likely no extra work needed; verify in execution.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────┐
│ Indexing path (writes)  │
└─────────────────────────┘

  ImageProcessor.process(job):
    ├─ ocr_extract(path)  ─→ chunk_text(...)  ─→ rows [role=body, idx 0..N]
    └─ caption_extract(path) ──────────────── ─→ row  [role=summary, idx "summary"]

  TextProcessor / PdfProcessor / URLCacheProcessor:
    └─ extracted text     ─→ chunk_text(...)  ─→ rows [role=body, idx 0..N]

                                                    │
                                                    ▼
                              ┌──────────────────────────────────┐
                              │ LanceDBStore.upsert(rows)        │
                              │                                  │
                              │ schema gains:  role: string      │
                              │ id format:     <node>:N or       │
                              │                <node>:summary    │
                              └──────────────────────────────────┘

┌─────────────────────────┐
│ Retrieval path (reads)  │
└─────────────────────────┘

  /index/node/{id}/content:
    rows = scan(node_id)
    rows.sort(key=_chunk_index_key)        # numeric idx ascending; summary last
    chunks = [{id, role, text} for r in rows]      # role uses _role_or_default
    joined = "\n\n".join(body_chunks) + ("\n\n" + summary if summary else "")
    return {node_id, kind, chunks, joined}

  Search orchestrator (unchanged in v1):
    fts_search/hybrid_search ─→ aggregate_per_node(max-score) ─→ results
                                        ▲
                                        │
                                        └── node-id-keyed; role mixing handled
                                            naturally by max-score
```

## Implementation Units

- [ ] **Unit 1: Add `role` column to lancedb schema with on-open migration**

  **Goal:** lancedb chunk schema gains a nullable `role: string` column. Existing tables migrate via `add_columns()`. `NodeChunk` dataclass + `_role_or_default()` helper land. Read paths surface role through the helper.

  **Requirements:** R1, R3 (read-side default to body for legacy rows).

  **Dependencies:** None.

  **Files:**
  - Modify: `sidecar/search_sidecar/storage/lancedb_store.py` (schema + NodeChunk + open_store + module/dataclass docstrings documenting the `role` column, allowed values, and `<node_id>:summary` chunk-id convention)
  - Modify: `sidecar/tests/test_lancedb_store.py`

  **Approach:**
  - `NodeChunk` dataclass gains `role: str = "body"` field; `to_arrow_dict()` includes it.
  - `_schema()` adds `("role", pa.string())` after `mount_id`.
  - `open_store()` after `db.open_table(...)`: introspect `table.schema`; if `role` not present, call `table.add_columns(pa.field("role", pa.string()))`. Wrap in try/except for `AlreadyExists`-style errors so concurrent restarts are idempotent.
  - New `ROLE_VALUES: frozenset[str] = frozenset({"body", "summary"})` constant.
  - New helper `_role_or_default(row: dict) -> str` that returns `row.get("role") or "body"`. Single source of role reads.
  - Module-level docstring updated to list the `role` column in the schema description and document the `<node_id>:summary` chunk-id convention; reference `_role_or_default` and `ROLE_VALUES`.
  - `find_stale_chunks()` and `replace_rows()` round-trip all columns via `to_pylist` already; verify with a test that role survives a re-embed.

  **Patterns to follow:**
  - Existing `open_store()` open-or-create-with-schema flow in `sidecar/search_sidecar/storage/lancedb_store.py`.
  - `merge_insert` is forbidden (lancedb 0.30 instability on macOS arm64); use `add_columns` for column add, `delete + add` for row replacements.

  **Test scenarios:**
  - Happy path: open fresh `LanceDBStore`; schema includes `role` column; upserting a `NodeChunk` with `role="body"` round-trips on `scan()`.
  - Edge case: open an existing table without `role` column (simulate by creating with the old schema, closing, reopening with new code); after `open_store()` returns, `role` column is present.
  - Edge case: `_role_or_default()` on a row with missing role returns `"body"`; on a row with `role="summary"` returns `"summary"`; on `role=None` returns `"body"`.
  - Integration: `find_stale_chunks()` returns rows that include role; passing those rows back through `replace_rows()` preserves the role on subsequent `scan()` reads (covers re-embed sweep round-trip).
  - Integration: idempotent open — calling `open_store()` twice in a row on the same table doesn't raise on the second `add_columns` attempt.

  **Verification:**
  - `from search_sidecar.storage import LanceDBStore, NodeChunk` round-trips a `role` value.
  - Pre-existing rows from a table created before this unit (via test fixture) read with `role` present after `open_store()`.

- [ ] **Unit 2: Processors emit role-tagged chunks; ImageProcessor stops emitting prefixes**

  **Goal:** Every processor explicitly tags its chunks. ImageProcessor splits OCR (body chunks) and caption (single summary row) into separate rows with no `OCR:` / `Caption:` prefixes baked into text.

  **Requirements:** R2, R3, R7.

  **Dependencies:** Unit 1.

  **Files:**
  - Modify: `sidecar/search_sidecar/index/processors/image.py`
  - Modify: `sidecar/search_sidecar/index/processors/text.py`
  - Modify: `sidecar/search_sidecar/index/processors/pdf.py`
  - Modify: `sidecar/search_sidecar/index/processors/url_cache.py`
  - Modify: `sidecar/tests/test_index_processors_image.py`
  - Modify: `sidecar/tests/test_index_processors_text.py`
  - Modify: `sidecar/tests/test_index_processors_pdf.py`
  - Modify: `sidecar/tests/test_index_processors_url_cache.py`

  **Approach:**
  - TextProcessor / PdfProcessor / URLCacheProcessor: each `NodeChunk(...)` literal in `process()` adds `role="body"` explicitly (no behavioural change; the explicit tag matches what they were always logically doing).
  - ImageProcessor:
    - Drop `_build_document()` and the `"OCR: …\n\nCaption: …"` concatenation entirely.
    - When `ocr_extract` yields non-empty text: feed into `chunk_text(...)`, emit one `NodeChunk` per chunk with `id=f"{node_id}:{idx}"`, `role="body"`. Same upsert path as today.
    - When `caption_extract` yields non-empty text: feed into `chunk_text(...)`, emit one `NodeChunk` per chunk with `id=f"{node_id}:summary:{idx}"`, `role="summary"`. Captions today produce a single row; long future summaries (D6) split naturally.
    - Both extractors empty → return 0 chunks (today's behavior).
    - Either extractor failing → log + skip that side, continue with the other (today's behavior; preserved).
    - Single `delete_by_node_id` then `upsert(rows)` with the combined body+summary row list — atomic-from-lancedb's-POV on a per-node basis.
  - Remove the now-unused `parseSections`-shaped concatenation helpers from `image.py`.

  **Patterns to follow:**
  - Existing `delete_by_node_id` + `upsert` pattern in TextProcessor / PdfProcessor.
  - Existing graceful-extractor-failure pattern in ImageProcessor's current `_build_document()`.

  **Test scenarios:**
  - Happy path (image, both sides): OCR extractor returns `"PKCE 1.0\nrefresh tokens"`, caption returns `"A cropped screenshot."` → store has body chunks for the OCR text and exactly one summary row containing `"A cropped screenshot."`. None of the rows contain the literal substring `"OCR:"` or `"Caption:"`.
  - Happy path (image, OCR only): caption extractor is None or returns empty → store has body chunks, zero summary rows.
  - Happy path (image, caption only): OCR extractor returns empty → store has zero body chunks, exactly one summary row.
  - Edge case (image, neither): no extractors → 0 rows written.
  - Edge case (image, very long caption): caption returns 800-char string → produces 2 summary rows (chunked through the same `chunk_text(...)` helper as body text). Each row is `<= MAX_CHUNK_CHARS`.
  - Edge case (image, OCR extractor raises): caption still indexed; one summary row, zero body rows.
  - Happy path (text/pdf/url): each writes rows with `role="body"`; assertion via `scan()` then `_role_or_default(row) == "body"` for every row.
  - Integration: re-index of an image (delete then re-process) replaces both body and summary rows together (no orphaned summary).
  - Regression for R7: index a small fixture corpus with images that have OCR text not containing the literal word "ocr" → FTS query for `ocr` returns zero matches.

  **Verification:**
  - No row in the store has text starting with `"OCR:"` or `"Caption:"` after re-indexing under the new ImageProcessor.
  - `scan(image_node_id)` returns body rows + at most one summary row, all with non-null role.

- [ ] **Unit 3: Update chunk sort + content endpoint + Rust/TS DTOs**

  **Goal:** `/index/node/{id}/content` returns ordered, role-tagged chunks. Body chunks sort by numeric index ascending; summary row sorts last. `joined` keeps the convention. Rust `NodeContentChunkDto` and TS `NodeContentChunk` gain the `role` field.

  **Requirements:** R5.

  **Dependencies:** Unit 1, Unit 2.

  **Files:**
  - Modify: `sidecar/search_sidecar/routes/index.py`
  - Modify: `sidecar/tests/test_index_routes.py`
  - Modify: `src-tauri/src/services/search/client.rs`
  - Modify: `src/lib/contracts/search.ts`
  - Modify: `src/features/search/types/search.ts`

  **Approach:**
  - `_chunk_index_key(row)` in `routes/index.py`:
    - Suffix is `"summary"` → return a large sentinel (e.g. `10**9`) so summary sorts last.
    - Suffix parses as int → return that int.
    - Anything else → return `0` (today's fallback; preserved).
  - `get_node_content` builds chunks list with `{id, role: _role_or_default(row), text}`. `joined` joins body chunks first (in-order), then appends summary text after `\n\n` if present.
  - Rust `NodeContentChunkDto`: add `pub role: String` with the same `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]` convention as the rest of the file. Add a round-trip serde test pinning that `"role": "summary"` decodes correctly and serializes camelCase doesn't leak `"role"` underscoring (already a single word, so no rename needed; assertion checks for completeness).
  - TS `NodeContentChunk` interface: add `role: string`.

  **Patterns to follow:**
  - Existing snake_case ↔ camelCase serde convention in `src-tauri/src/services/search/client.rs` (see `SearchResultDto` round-trip test pattern).
  - Existing structured-DTO-then-thin-IPC-passthrough in `src/lib/tauri/ipc.ts:getNodeContent`.

  **Test scenarios:**
  - Happy path: GET `/index/node/{id}/content` for a node with both body chunks and a summary row → response chunks list has body entries first (sorted by numeric idx), summary entry last; each entry carries the right role.
  - Happy path: GET for a body-only node → chunks all `role=body`, no summary entry.
  - Edge case: GET for an unindexed node → `{node_id, kind: null, chunks: [], joined: ""}` (today's behavior preserved).
  - Edge case: legacy node with no `role` column populated → reads default to `"body"`; response carries `role="body"` for every chunk.
  - Edge case: `joined` for a node with body+summary contains body text first, two newlines, then the summary text. No `OCR:`/`Caption:` prefixes.
  - Integration (Rust round-trip): JSON `{"chunks": [{"id": "n:0", "role": "body", "text": "x"}, {"id": "n:summary", "role": "summary", "text": "y"}]}` decodes to `NodeContentDto`; re-serializing produces camelCase top-level fields and preserves `role` in chunks.
  - Edge case (sort): a node with body chunks ids `n:0, n:1, n:10, n:11, n:2` and a summary chunk `n:summary` → ordered as 0, 1, 2, 10, 11, summary.

  **Verification:**
  - `curl /index/node/{id}/content` against a fixture with mixed roles returns chunks in the documented order with role fields populated.
  - Rust client tests assert the full round-trip including the new field.

- [ ] **Unit 4: ImagePreview filters by role; parseSections removed**

  **Goal:** The center-pane `ImagePreview` consumes `chunks[]` directly, filtering by role to render OCR (body) and Caption (summary) sections. The `parseSections` regex helper and its tests are removed from the codebase.

  **Requirements:** R5, satisfies origin Success Criterion #2.

  **Dependencies:** Unit 3.

  **Files:**
  - Modify: `src/features/explorer/components/ImagePreview.tsx`
  - Modify: `src/features/explorer/components/ImagePreview.test.tsx`

  **Approach:**
  - Component fetches `nodeContent(nodeId)` as today; consumes `data.chunks` directly instead of `data.joined`.
  - Body chunks (`role==='body'`) → render under the existing "OCR" header; concatenate their text in chunk order via React text nodes (no `dangerouslySetInnerHTML`).
  - Summary chunks (`role==='summary'`) → render the single chunk's text under the "Caption" header.
  - Either category empty → omit that section. Both empty → existing empty-state copy unchanged.
  - Delete `parseSections` from the file. Delete `parseSections.test.tsx`-style tests from the test file.

  **Patterns to follow:**
  - Existing React-text-node-only rendering convention (SEC-FINDING-002 carry-forward — never `dangerouslySetInnerHTML` on indexed content).
  - Existing `useEffect`-fetch + cancelled flag pattern from `MarkdownPreview` and the current `ImagePreview` body.

  **Test scenarios:**
  - Happy path: chunks include `[{role: "body", text: "OAuth 2.1"}, {role: "body", text: "PKCE flow"}, {role: "summary", text: "Diagram of three boxes"}]` → renders an OCR section with body text concatenated and a Caption section with the summary text. Neither contains the literal `"OCR:"` or `"Caption:"` prefix.
  - Edge case: only body chunks → only OCR section renders; no Caption header.
  - Edge case: only summary chunk → only Caption section renders; no OCR header.
  - Edge case: empty chunks → existing empty-state copy renders unchanged.
  - Edge case (legacy data): a body chunk whose text contains the literal substring `"OCR:"` (e.g. someone wrote it in a real document) renders verbatim under OCR header — no double-stripping.
  - Regression: `parseSections` is no longer exported from `ImagePreview.tsx` (TS compile-time check — any leftover imports would fail).

  **Verification:**
  - `grep -r parseSections src/` returns no results after this unit.
  - All existing ImagePreview tests pass against the new role-filter implementation; tests previously asserting `parseSections` behaviour are removed.

- [ ] **Unit 5: Sidecar contract documentation + content-endpoint regression test**

  **Goal:** Capture the contract (`role` allowed values, summary chunk-id convention, joined ordering) inline in `lancedb_store.py` and `routes/index.py` docstrings. Add a single regression test that exercises the cross-layer flow end-to-end (image processor writes → endpoint reads → response shape).

  **Requirements:** R7 (regression coverage); doc completeness for handoff to Unit 6 (deferred).

  **Dependencies:** Unit 1, Unit 2, Unit 3.

  **Files:**
  - Modify: `sidecar/search_sidecar/routes/index.py` (`/index/node/{id}/content` endpoint docstring)
  - Modify: `sidecar/tests/test_index_processors_image.py` (cross-layer regression test)

  **Approach:**
  - The `lancedb_store.py` module/dataclass docstring updates already land in Unit 1 (which is the unit that touches the schema and dataclass).
  - Update `routes/index.py` `get_node_content` docstring: document the body-first-summary-last ordering and the `joined` rule.
  - Add a regression test in `test_index_processors_image.py` that simulates `ocr_extract`/`caption_extract` callables, runs `ImageProcessor.process()`, then calls the route's `get_node_content` against the same store and asserts the full response shape (chunks order, roles, joined text).

  **Patterns to follow:**
  - Existing test pattern in `test_index_routes.py` that uses `TestClient(build_app(...))` for cross-layer integration.

  **Test scenarios:**
  - Integration: ImageProcessor writes (mocked OCR returns 600 chars, caption returns 100 chars) → GET response chunks in order `[body 0, body 1, summary]`; `joined` contains all of OCR text then `\n\n` then caption text; no `OCR:`/`Caption:` substrings anywhere.
  - Test expectation: docstring updates have no behavioral test — covered by the integration scenario above plus the structural assertions already in Units 1-3.

  **Verification:**
  - The regression test passes against the changes from Units 1-4.
  - `routes/index.py` endpoint docstring documents the body-first-summary-last ordering rule.
  - (`lancedb_store.py` docstring updates were verified by Unit 1.)

## System-Wide Impact

- **Interaction graph:** ImageProcessor (writer) → LanceDBStore.upsert (writer) → lancedb table → LanceDBStore.scan (reader) → /index/node/{id}/content (HTTP response) → Rust `node_content` IPC → TS `getNodeContent` → ImagePreview (renderer). Every layer changes shape; the regression test in Unit 5 covers the full chain.
- **Error propagation:** A single side of the image extractor failing (OCR errors but caption succeeds, or vice versa) continues to log + skip per existing behaviour — Unit 2 preserves that. A schema migration failure in `add_columns()` should be retried-then-logged; if it persists, the sidecar logs a clear error and continues with the existing table (FTS still works on legacy text).
- **State lifecycle risks:** Re-index of an image must atomically replace body+summary rows (single `delete_by_node_id` + single `upsert(combined_rows)`). Partial re-index where only OCR finishes before the captioner errors leaves stale summary; the existing `delete_by_node_id` covers this because it runs at the *start* of `process()`, removing all old rows for that node up front.
- **API surface parity:**
  - `/index/node/{id}/content` JSON shape changes (chunks gain a `role` field). All current consumers (Rust IPC, TS `getNodeContent`, ImagePreview) update in this plan. No external consumers documented today.
  - Per-node `joined` semantics change subtly (summary appended at end). ImagePreview no longer reads `joined`; no other consumer documented.
- **Integration coverage:** Cross-layer scenarios that mocks alone won't prove — the Unit 5 regression test exercises ImageProcessor writes + endpoint reads against a real lancedb store.
- **Unchanged invariants:**
  - The `searchQuery` IPC contract — `role` is not exposed to search clients today; results are still per-node aggregated rows.
  - The `delete_by_node_id` predicate — still removes every chunk for a node regardless of role.
  - The Rust forwarder's `node-deleted` cascade payload — unchanged; deletions still happen by node_id alone.
  - SEC-FINDING-002 — frontend renders snippet/text via React text nodes only, never `dangerouslySetInnerHTML`. Unit 4 preserves this.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `add_columns()` semantics differ across lancedb 0.30 patch versions or fail under concurrent open. | Implementation wraps in try/except; on AlreadyExists treat as success; on other errors log + continue with the existing table (degraded but safe). Unit 1 idempotency test covers double-call. |
| BM25 length-normalization makes short summary rows over-score body matches once D6 lands. | Documented as a known follow-up in Key Decisions. v1 has at most one summary row per image, and the current corpus is near-zero, so the inversion is theoretical until D6. Revisit when there's measurable signal. |
| Pre-schema legacy image rows still carry `OCR:`/`Caption:` prefixes after this lands. | Origin doc explicitly accepts this; user has near-zero real image data today. Natural reindex on next ImageProcessor run cleans them. Unit 4's "legacy data" edge-case test covers the rendering path. |
| `_chunk_index_key`'s sentinel value is order-of-magnitude-fragile if a node ever has more than 10⁹ body chunks. | Practical impossibility (chunker caps at 512 chars, max docs are ~50 pages = thousands of chunks at most). If real, sentinel can grow. Documented in code comment. |
| Other consumers of `joined` (future agent tooling, external scripts) silently get a different shape once summary content is included. | Currently no external consumers documented. The body-first-then-summary rule is deterministic; if a future consumer wants body-only, they iterate `chunks` filtered by role. Document the rule in the endpoint docstring (Unit 5). |
| Rust client round-trip for the new `role` field misses some serde edge case (carry-forward of the snake/camel incident). | Unit 3 includes an explicit round-trip test pinning the field's serialization. |

## Documentation / Operational Notes

- The sidecar restarts on schema change naturally — Unit 1's `add_columns()` runs on every `open_store()` call. No deploy-time migration step.
- No changes to `~/.cogios/search/` directory layout. The lancedb store directory path is unchanged.
- Re-embed sweep (`embeddings/reembed.py`) continues to work unchanged — Unit 1 verifies the role column round-trips through `find_stale_chunks` / `replace_rows` without explicit handling.
- The deferred `D6` work (document summary generation) inherits this schema directly. When a future plan implements summarization, it writes `<node_id>:summary` rows with `role="summary"` and inherits the existing rendering, sort, and joined ordering.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-02-chunk-role-schema-requirements.md](../brainstorms/2026-05-02-chunk-role-schema-requirements.md)
- **Document review findings (informing Key Decisions):** see synthesis on origin doc; F1, F2, F4/P3/A3, C3, C5, P2, A2, A6, A8 all resolved by decisions captured above.
- **Related code:**
  - `sidecar/search_sidecar/storage/lancedb_store.py` (schema + NodeChunk + open_store)
  - `sidecar/search_sidecar/index/processors/image.py` (current `_build_document` to be removed)
  - `sidecar/search_sidecar/routes/index.py` (endpoint + `_chunk_index_key`)
  - `src-tauri/src/services/search/client.rs` (NodeContentChunkDto)
  - `src/features/explorer/components/ImagePreview.tsx` (parseSections to be removed)
- **Related prior work:**
  - Commit `ed3e997` — snake_case ↔ camelCase serde split-form (pattern for the new `role` field round-trip).
  - Commit `ca0de87` — cascade-delete forwarding (pattern for default-on-deserialize in `VfsChangeEvent`).
- **External docs:** None — lancedb behaviour known from local work.
