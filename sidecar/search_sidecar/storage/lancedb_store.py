"""lancedb-backed authoritative chunk store.

Schema (single table named ``nodes``)::

    id            string   PRIMARY KEY  -- "<node_id>:<chunk_idx>" or "<node_id>:summary:<chunk_idx>"
    node_id       string                -- the parent node
    kind          string                -- note | file | url | folder | mount
    name          string                -- display name (also indexed for keyword path)
    text          string                -- the chunk's plaintext
    vector        list<float32, 768>    -- embedding (zero-vector while no embedder is wired)
    mount_id      string  nullable
    created_at    timestamp[ms]
    modified_at   timestamp[ms]
    role          string  nullable      -- "body" | "summary" | "metadata" | "voice_transcript"; legacy rows are NULL
    content_version string nullable     -- sidecar queue content fingerprint

Chunk-id formats:

- ``"<node_id>:<int>"`` for ``role=body`` chunks (``int`` is the chunk
  index in the original document).
- ``"<node_id>:summary:<int>"`` for ``role=summary`` chunks (same int
  index convention as body). Today's image captions typically fit in
  a single row; the chunker may split longer future summaries (D6)
  into multiple rows without further schema work.
- ``"<node_id>:metadata:0"`` for ``role=metadata`` chunks. These rows
  contain node names and paths so metadata-only matches can surface
  without mixing internal search text into preview content.
- ``"<node_id>:voice_transcript:<int>"`` for ``role=voice_transcript``
  chunks. These are the live/final voice-note transcript file, kept
  separate from the note body's summary and action-item text.

Both share the same ``node_id`` column so a single
``DELETE WHERE node_id = ?`` predicate still removes every chunk for
a node, regardless of role.

The ``role`` column is nullable because the table existed before the
column was added — pre-schema rows read as ``NULL`` and are coerced
to ``"body"`` via :func:`role_or_default`. Every reader of this
column should go through that helper, not access the field directly.
The allowed value set lives in :data:`ROLE_VALUES`.

Indexes (FTS, vector ANN, scalar) are NOT built here — they land in
Unit 6 once retrieval ships. This module only exposes the persistence
primitives processors need: ``upsert(rows)``, ``delete_by_node_id(id)``,
``count()``, ``list_node_ids()``, ``scan(node_id)``.

Embedding dimension is 768 (matches ``onnx-community/gte-multilingual-base``).
A schema change requires a re-index (the plan's R18 model-swap flow);
that machinery is Unit 6 territory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal

import lancedb
import pyarrow as pa

from .migrations import run_migrations

EMBEDDING_DIMENSION = 768
TABLE_NAME = "nodes"

# Allowed values for the ``role`` column. Adding a new role is a code
# change — kept as a frozenset so processors can assert membership at
# the boundary without duplicating the typing.Literal definition on NodeChunk.role.
Role = Literal["body", "summary", "metadata", "voice_transcript"]
ROLE_VALUES: frozenset[str] = frozenset(
    {"body", "summary", "metadata", "voice_transcript"}
)


@dataclass(frozen=True)
class NodeChunk:
    """One row in the ``nodes`` table — a single chunk of one node's content.

    ``role`` describes the kind of chunk for the UI/retrieval layer:

    - ``"body"`` — literal content (text chunks, OCR text, PDF text,
      stripped HTML body). The default; this is what every processor
      emitted before the role column existed.
    - ``"summary"`` — a generated description attached to a node
      (today: image captions; reserved for future doc summaries).
      Summary text is chunked through the same ``chunk_text`` helper
      as body text, with ids ``"<node_id>:summary:<int>"``. Captions
      typically fit in a single row today.
    - ``"metadata"`` — internal search text derived from node names
      and paths. Preview endpoints hide these rows.
    - ``"voice_transcript"`` — transcript text for a voice note,
      sourced from the sibling transcript file rather than the note
      markdown body.

    Modality (image / audio / text) is intentionally *not* encoded
    here; if it is ever needed it goes in a separate column.
    """

    id: str
    node_id: str
    kind: str
    name: str
    text: str
    vector: list[float]  # length must be EMBEDDING_DIMENSION
    mount_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    modified_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    role: Role = "body"
    content_version: str | None = None

    def __post_init__(self) -> None:
        if len(self.vector) != EMBEDDING_DIMENSION:
            raise ValueError(
                f"vector length {len(self.vector)} != {EMBEDDING_DIMENSION}"
            )
        if self.role not in ROLE_VALUES:
            raise ValueError(
                f"role {self.role!r} not in {sorted(ROLE_VALUES)!r}"
            )

    def to_arrow_dict(self) -> dict:
        return {
            "id": self.id,
            "node_id": self.node_id,
            "kind": self.kind,
            "name": self.name,
            "text": self.text,
            "vector": self.vector,
            "mount_id": self.mount_id,
            "created_at": self.created_at,
            "modified_at": self.modified_at,
            "role": self.role,
            "content_version": self.content_version,
        }


def _schema() -> pa.Schema:
    return pa.schema(
        [
            ("id", pa.string()),
            ("node_id", pa.string()),
            ("kind", pa.string()),
            ("name", pa.string()),
            ("text", pa.string()),
            ("vector", pa.list_(pa.float32(), EMBEDDING_DIMENSION)),
            ("mount_id", pa.string()),
            ("created_at", pa.timestamp("ms", tz="UTC")),
            ("modified_at", pa.timestamp("ms", tz="UTC")),
            ("role", pa.string()),
            ("content_version", pa.string()),
        ]
    )


def role_or_default(row: dict) -> Role:
    """Return ``row['role']`` or ``"body"`` if the column is missing/null.

    Single source of truth for reading the ``role`` column. Pre-schema
    rows (written before the column existed) read as ``None`` here;
    every other layer should call this rather than poking the dict
    directly so the legacy fallback stays consistent.
    """
    value = row.get("role")
    if value in ROLE_VALUES:
        return value  # type: ignore[return-value]
    return "body"


class LanceDBStore:
    """Thin wrapper over a single lancedb table.

    Constructed via :func:`open_store`. Methods are synchronous because
    lancedb's Python API is sync; the indexing runner calls these from
    a worker thread (see :mod:`search_sidecar.index.runner`).
    """

    def __init__(self, db, table) -> None:  # type: ignore[no-untyped-def]
        self._db = db
        self._table = table
        self._fts_index_built = False

    @property
    def table(self):  # type: ignore[no-untyped-def]
        return self._table

    def upsert(self, chunks: Iterable[NodeChunk]) -> int:
        """Insert (or replace) chunks. Replacement key is ``id``.

        Implementation: delete-then-add. lancedb 0.30's ``merge_insert``
        had a tendency to surface async-runtime spill errors on macOS
        arm64 (RuntimeError: "Spill has sent an error"); the explicit
        delete + add is supported on every lancedb version we target
        and has comparable performance for the sub-thousand-row batches
        the indexer produces. Worth revisiting once lancedb stabilises
        merge_insert.
        """
        rows = [c.to_arrow_dict() for c in chunks]
        if not rows:
            return 0
        ids = [r["id"] for r in rows]
        in_clause = ", ".join(f"'{_quote(i)}'" for i in ids)
        self._table.delete(f"id IN ({in_clause})")
        self._table.add(rows)
        return len(rows)

    def delete_by_node_id(self, node_id: str) -> None:
        """Remove every chunk whose ``node_id`` matches.

        Caller is responsible for validating the id format upstream
        (see plan SEC-FINDING-005). Here we only escape single quotes
        to avoid breaking the predicate string.
        """
        self._table.delete(f"node_id = '{_quote(node_id)}'")

    def delete_chunks_by_role(
        self, node_id: str, role: Role
    ) -> None:
        """Remove only one role for a node.

        Prefer this during image-OCR enhancement, where advanced OCR
        replaces body chunks while preserving summary/caption chunks.
        Use :meth:`delete_by_node_id` for a full node re-index.
        """
        if role not in ROLE_VALUES:
            raise ValueError(f"role {role!r} not in {sorted(ROLE_VALUES)!r}")
        role_predicate = (
            "(role = 'body' OR role IS NULL)"
            if role == "body"
            else f"role = '{_quote(role)}'"
        )
        self._table.delete(f"node_id = '{_quote(node_id)}' AND {role_predicate}")

    def replace_node_chunks(
        self,
        node_id: str,
        chunks: Iterable[NodeChunk],
    ) -> int:
        """Replace one node's chunks after new rows are ready.

        Re-indexing should not make an existing node disappear from
        search while extraction / embedding is still in progress. This
        method writes replacement ids first, then removes stale ids
        from the same node. If ``chunks`` is empty, the successful
        replacement is "no content" and all previous chunks are
        removed.
        """
        rows = list(chunks)
        self._validate_replacement_rows(node_id, rows)
        if rows:
            self.upsert(rows)
            self._delete_stale_node_rows(node_id, [row.id for row in rows])
        else:
            self.delete_by_node_id(node_id)
        return len(rows)

    def replace_chunks_by_role(
        self,
        node_id: str,
        role: Role,
        chunks: Iterable[NodeChunk],
    ) -> int:
        """Replace one role's chunks after new rows are ready."""
        if role not in ROLE_VALUES:
            raise ValueError(f"role {role!r} not in {sorted(ROLE_VALUES)!r}")
        rows = list(chunks)
        self._validate_replacement_rows(node_id, rows, role=role)
        if rows:
            self.upsert(rows)
            self._delete_stale_node_rows(
                node_id,
                [row.id for row in rows],
                role=role,
            )
        else:
            self.delete_chunks_by_role(node_id, role)
        return len(rows)

    def delete_by_node_ids(self, node_ids: Iterable[str]) -> None:
        ids = [i for i in node_ids if i]
        if not ids:
            return
        in_clause = ", ".join(f"'{_quote(i)}'" for i in ids)
        self._table.delete(f"node_id IN ({in_clause})")

    def _validate_replacement_rows(
        self,
        node_id: str,
        rows: list[NodeChunk],
        *,
        role: Role | None = None,
    ) -> None:
        for row in rows:
            if row.node_id != node_id:
                raise ValueError(
                    f"replacement row node_id {row.node_id!r} != {node_id!r}"
                )
            if role is not None and row.role != role:
                raise ValueError(
                    f"replacement row role {row.role!r} != {role!r}"
                )

    def _delete_stale_node_rows(
        self,
        node_id: str,
        keep_ids: list[str],
        *,
        role: Role | None = None,
    ) -> None:
        in_clause = ", ".join(f"'{_quote(i)}'" for i in keep_ids)
        predicate = f"node_id = '{_quote(node_id)}' AND id NOT IN ({in_clause})"
        if role is not None:
            role_predicate = (
                "(role = 'body' OR role IS NULL)"
                if role == "body"
                else f"role = '{_quote(role)}'"
            )
            predicate += f" AND {role_predicate}"
        self._table.delete(predicate)

    def count(self) -> int:
        """Total row count across all nodes."""
        return self._table.count_rows()

    def find_stale_chunks(self) -> list[dict]:
        """Return every row whose ``vector`` is the all-zero stub
        marker — i.e. chunks indexed under :class:`StubEmbedder` that
        a real embedder should re-embed.

        L2-normalised vectors from :class:`GteEmbedder` always have
        norm 1.0, so all-zero is an unambiguous discriminator. Each
        returned dict carries every column needed to re-add the row
        with a fresh vector via :meth:`replace_rows`.

        Loads the full table into memory; v1 caps the workspace at
        ~100K chunks where this is fine (<1 s, ~300 MB). A streaming
        scan is the obvious upgrade for larger corpora but adds
        complexity that is not warranted today.
        """
        if self._table.count_rows() == 0:
            return []
        rows = self._table.to_arrow().to_pylist()
        stale: list[dict] = []
        for row in rows:
            vector = row.get("vector")
            if vector is None:
                continue
            if all(x == 0.0 for x in vector):
                stale.append(row)
        return stale

    def replace_rows(self, rows: list[dict]) -> int:
        """Bulk replace by ``id``: delete every matching id, then add
        the new rows. Used by the re-embed sweep, which feeds full
        row dicts with refreshed ``vector`` values back in.

        Mirrors :meth:`upsert` but skips the :class:`NodeChunk`
        round-trip — the caller already has lancedb's native row
        shape from :meth:`find_stale_chunks`.
        """
        if not rows:
            return 0
        ids = [r["id"] for r in rows]
        in_clause = ", ".join(f"'{_quote(str(i))}'" for i in ids)
        self._table.delete(f"id IN ({in_clause})")
        self._table.add(rows)
        return len(rows)

    def list_node_ids(self) -> set[str]:
        """The distinct ``node_id`` values currently in the table.

        Used by retrieval/bootstrap code that needs a cheap view of
        which nodes currently have indexed rows.
        """
        # to_arrow with column projection is the lancedb-version-stable
        # accessor for one column across the whole table; to_pandas's
        # ``columns=`` kwarg is recent and missing on the version we
        # currently pin.
        if self._table.count_rows() == 0:
            return set()
        arrow_table = self._table.to_arrow()
        column = arrow_table.column("node_id").to_pylist()
        return {value for value in column if value is not None}

    def scan(self, node_id: str) -> list[dict]:
        """Return every chunk row for one node (test/debug helper)."""
        return (
            self._table.search()
            .where(f"node_id = '{_quote(node_id)}'")
            .to_list()
        )

    def scan_mount_nodes(
        self,
        mount_id: str,
        *,
        limit: int = 100,
        kinds: set[str] | None = None,
    ) -> list[dict]:
        """Return distinct indexed nodes that belong to one mount."""
        if self._table.count_rows() == 0:
            return []
        rows = (
            self._table.search()
            .where(f"mount_id = '{_quote(mount_id)}'")
            .limit(max(limit * 20, limit))
            .to_list()
        )
        by_node_id: dict[str, dict] = {}
        for row in rows:
            node_id = row.get("node_id")
            if not node_id or node_id in by_node_id:
                continue
            kind = row.get("kind") or ""
            if kinds is not None and kind not in kinds:
                continue
            by_node_id[node_id] = {
                "node_id": node_id,
                "kind": kind,
                "name": row.get("name") or node_id,
                "mount_id": row.get("mount_id"),
                "modified_at": row.get("modified_at"),
            }
            if len(by_node_id) >= limit:
                break
        return sorted(
            by_node_id.values(),
            key=lambda row: (str(row.get("name") or ""), str(row.get("node_id") or "")),
        )

    def scan_user_chunks(self, *, limit: int = 2_000) -> list[dict]:
        """Return user-visible chunks for synthesis-style consumers.

        Topic Memory should never build on metadata-only rows because
        those rows contain internal search text rather than user-visible
        evidence. The returned rows are sorted newest-first so bounded
        proposal generation prefers recent material without hiding older
        rows when the index is small.
        """
        row_count = self._table.count_rows()
        if row_count == 0:
            return []
        columns = [
            "id",
            "node_id",
            "kind",
            "name",
            "text",
            "mount_id",
            "created_at",
            "modified_at",
            "role",
            "content_version",
        ]
        rows = (
            self._table.search()
            .select(columns)
            .where("role IS NULL OR role != 'metadata'")
            .limit(row_count)
            .to_arrow()
            .to_pylist()
        )
        visible = [
            row
            for row in rows
            if str(row.get("text") or "").strip()
        ]
        visible.sort(
            key=lambda row: (
                str(row.get("modified_at") or ""),
                str(row.get("node_id") or ""),
                str(row.get("id") or ""),
            ),
            reverse=True,
        )
        return visible[: max(1, limit)]

    def update_node_metadata(
        self,
        node_id: str,
        *,
        kind: str,
        name: str,
        mount_id: str | None,
        modified_at: datetime | None,
    ) -> int:
        """Update metadata columns for existing chunks without re-indexing text."""
        rows = self.scan(node_id)
        if not rows:
            return 0
        for row in rows:
            row["kind"] = kind
            row["name"] = name
            row["mount_id"] = mount_id
            if modified_at is not None:
                row["modified_at"] = modified_at
        return self.replace_rows(rows)

    def ensure_fts_index(self, *, force: bool = False) -> None:
        """Build the FTS index on the ``text`` column if not already
        built in this process's lifetime.

        lancedb's ``create_fts_index`` is idempotent with ``replace=True``
        — it rebuilds in place. We cache a per-process flag so a series
        of search calls doesn't trigger repeated index rebuilds; new
        upserts after the index is built are picked up by lancedb's
        own incremental indexing on subsequent search calls.

        ``force=True`` skips the cache and rebuilds — useful after a
        bulk re-index.
        """
        if self._fts_index_built and not force:
            return
        if self._table.count_rows() == 0:
            # ``create_fts_index`` on an empty table is a no-op but
            # some lancedb versions error; skip until we have rows.
            return
        try:
            self._table.create_fts_index(
                "text", use_tantivy=False, replace=True
            )
        except TypeError:
            # Older lancedb signatures don't accept use_tantivy
            self._table.create_fts_index("text", replace=True)
        self._fts_index_built = True

    def fts_search(
        self,
        query: str,
        *,
        filter_sql: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Run an FTS-only query and return raw chunk rows.

        Returns dicts with the schema's columns plus a ``_score`` key
        added by lancedb's FTS path. The retrieval orchestrator
        aggregates these per-node before returning to callers.
        """
        if not query.strip():
            return []
        self.ensure_fts_index()
        if self._table.count_rows() == 0:
            return []
        builder = self._table.search(query, query_type="fts")
        if filter_sql:
            builder = builder.where(filter_sql)
        return builder.limit(limit).to_list()

    def hybrid_search(
        self,
        query: str,
        query_vec: list[float],
        *,
        filter_sql: str | None = None,
        limit: int = 200,
    ) -> list[dict]:
        """Run a hybrid (FTS + vector) query and return raw chunk rows.

        Hybrid path requires both an FTS index on ``text`` and a
        vector index on ``vector``. lancedb 0.30 validates hybrid
        queries as either a string passed to ``search()`` or an
        explicit ``.vector(...).text(...)`` pair, but not both. Use
        the explicit pair so the call remains clear about which vector
        came from our embedder.

        See plan note on lancedb #1656: prefer post-filter
        (``prefilter=False``) when both an FTS index and a scalar
        index are present and a filter is applied. The over-fetch +
        in-memory aggregation step in the orchestrator covers the
        residual gap.
        """
        if not query.strip():
            return []
        if len(query_vec) != EMBEDDING_DIMENSION:
            raise ValueError(
                f"query_vec length {len(query_vec)} != {EMBEDDING_DIMENSION}"
            )
        self.ensure_fts_index()
        if self._table.count_rows() == 0:
            return []
        builder = self._call_hybrid(query, query_vec)
        if filter_sql:
            try:
                builder = builder.where(filter_sql, prefilter=False)
            except TypeError:
                builder = builder.where(filter_sql)
        return builder.limit(limit).to_list()

    def _call_hybrid(self, query: str, query_vec: list[float]):
        """Call lancedb's hybrid API across version differences.

        Returns a search builder; the caller adds ``where`` + ``limit``.
        """
        try:
            return (
                self._table.search(query_type="hybrid")
                .vector(query_vec)
                .text(query)
            )
        except TypeError:
            # Older API: chain .vector() after the text/query call.
            return self._table.search(query, query_type="hybrid").vector(
                query_vec
            )


def open_store(path: Path) -> LanceDBStore:
    """Open or create the lancedb store at ``path``.

    The first call creates an empty ``nodes`` table with the schema
    declared at module level. Subsequent calls open the existing
    table and run the additive column migrations declared in
    :mod:`search_sidecar.storage.migrations`. Schema migrations beyond
    additive column adds — type changes, vector dimension swaps —
    require a re-index (Unit 6 territory).
    """
    path.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(path))
    # ``list_tables()`` is unreliable in lancedb 0.30 — sometimes returns
    # an empty list even with tables present on disk. The robust path is
    # try-open, fall through to create-with-schema on failure.
    try:
        table = db.open_table(TABLE_NAME)
    except Exception:
        table = db.create_table(TABLE_NAME, schema=_schema(), exist_ok=True)
    run_migrations(table)
    return LanceDBStore(db, table)


def _quote(value: str) -> str:
    """Escape single quotes for inclusion in a lancedb WHERE clause.

    lancedb's Python API does not currently expose parameterised
    predicates; this is the SEC-FINDING-005 mitigation in lieu of one.
    Caller is still responsible for validating the value's *shape*
    (e.g. node_id as UUID) before this is called.
    """
    return value.replace("'", "''")
