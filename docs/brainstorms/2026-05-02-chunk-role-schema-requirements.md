---
date: 2026-05-02
topic: chunk-role-schema
---

# Chunk Role Schema — Body vs Summary

## Problem Frame

Today's lancedb chunk store is **stringly-typed**: every row is a `text` blob with no field telling the system what kind of content the chunk is. ImageProcessor works around this by encoding the chunk type as a string prefix (`"OCR: …\n\nCaption: …"`) and concatenating both pieces into a single document before chunking.

Two problems flow from this:

1. **Search contamination.** Because `"OCR:"` and `"Caption:"` are baked into every image's chunk text, the FTS index treats those literal terms as content. Searching `ocr` or `caption` returns every indexed image — false-positive flood.
2. **Conceptual conflation.** OCR text (literal content extracted from an image) and a caption (generated description) are different modalities with different retrieval semantics. They should be queryable independently and rendered separately in the UI without string parsing.

The same shape will repeat as the system grows: documents may want generated summaries; URLs may want title-line distillations; audio may want transcripts. All of these are "non-body content attached to a node", and the index needs to model that explicitly rather than smuggle it through prefixes.

## Decisions

### D1. Add a `role` column to the lancedb chunk schema

The `nodes` table gains one new string column: `role`. Allowed values for v1:

- `body` — literal content extracted from the source. Chunked as today.
- `summary` — short generated description of the whole node. Single-row, not chunked further.

Future roles (e.g. `transcript`) plug in without further schema changes.

### D2. Image processor writes role-tagged rows, not concatenated text

ImageProcessor stops emitting `"OCR: …\n\nCaption: …"`. Instead:

- OCR text → one or more rows with `role = body` (chunked normally if long).
- Caption text → exactly one row with `role = summary`.

Either side may be empty (no extractor wired, blank result). The processor writes only the rows that have content.

### D3. Existing processors default to `role = body`

`TextProcessor`, `PdfProcessor`, and `URLCacheProcessor` continue writing one or more chunks per node, all tagged `role = body`. No behaviour change; the column just makes their existing role explicit.

### D4. Search treats every role as searchable; no role weighting in v1

Queries hit all roles by default. The orchestrator's existing per-`node_id` aggregation (max-score wins) coalesces multi-role hits into a single result row. Caption matches and body matches are not weighted differently — the FTS scorer's natural behaviour is good enough until we have a reason to override it.

Per-role *filtering* (e.g. `role:summary oauth`) is **not** in scope for v1. Inline-syntax surface stays small until users actually ask for it.

### D5. The `/index/node/{id}/content` response carries role information

Today the endpoint returns `{node_id, kind, chunks: [...], joined: "..."}`. The chunks array gains a `role` field per entry. `joined` stays for backwards-compatibility; clients that want structured rendering iterate `chunks` directly.

The `ImagePreview` frontend component switches from `parseSections(joined)` (regex-on-prefix heuristic) to filtering chunks by role — `role=body` becomes the OCR section, `role=summary` becomes the caption section. The `parseSections` helper is deleted.

### D6. Summary generation for documents is deferred

This brainstorm reserves the schema slot for `role = summary` on documents (PDF, notes, URLs) but does **not** implement the generation pipeline. When summary generation lands later, it writes through the same schema; no further migration is needed.

## Migration

The lancedb table grows a column. Behaviour for existing data:

- Rows written before this change have no `role` value. Treat missing as `role = body` (for sidecar-side reads and frontend filtering).
- Image rows written before this change still carry the `"OCR:"`/`"Caption:"` string prefixes in their `text` field — they will look weird in the new ImagePreview UI until re-indexed. The user has very little real image data today (the OCR/captioner extractors aren't wired); accept the temporary cosmetic weirdness rather than build a one-shot data-rewrite.
- New writes follow the new schema unconditionally.

## Out of Scope

- **Summary generation pipeline for documents.** Choosing a summarizer (Gemma via llama-server? smaller model? heuristic?), debouncing regeneration on save, model-cost budgeting — all defer until a separate brainstorm.
- **Per-role search filters.** No `role:` operator in the inline query syntax until a concrete use case appears.
- **Role-aware ranking.** No score boost/penalty for caption vs body hits in v1.

## Success Criteria

1. **For nodes indexed under the new schema**, searching the literal terms `ocr` or `caption` returns only nodes whose **content** (OCR text body or caption text) actually contains those words — never matches an image just because the system stored those terms as prefixes. (Pre-schema image rows retain their string prefixes until re-indexed; see Migration. The criterion holds globally once the existing image set has cycled through a re-index.)
2. The `ImagePreview` center pane renders OCR text and caption text as distinct sections without parsing string prefixes; the `parseSections` helper is removed from the codebase.
3. The `/index/node/{id}/content` endpoint exposes `role` per chunk; clients can render structured views without string heuristics.
4. Adding a future `role = summary` for documents requires only writing new rows — no further schema changes.

## Open Questions (defer to planning)

- Whether to migrate-and-rewrite existing pre-schema rows or accept they look weird until reindex (recommendation: accept; data volume is trivial).
- Whether to bump a stored schema-version sentinel for future-proofing migrations.
- Whether the `role` column needs an index. Probably not — searches don't filter by role today; node-level aggregation handles dedup. Add only if a measured hot path appears.
