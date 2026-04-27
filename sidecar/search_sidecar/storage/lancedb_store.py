"""lancedb-backed authoritative chunk store.

Schema (single table named ``nodes``)::

    id            string   PRIMARY KEY  -- "<node_id>:<chunk_idx>"
    node_id       string                -- the parent node
    kind          string                -- note | file | url | folder | mount | directory
    name          string                -- display name (also indexed for keyword path)
    text          string                -- the chunk's plaintext
    vector        list<float32, 768>    -- embedding (zero-vector while no embedder is wired)
    mount_id      string  nullable
    created_at    timestamp[ms]
    modified_at   timestamp[ms]

The chunk-id format ``"<node_id>:<chunk_idx>"`` lets us delete every
chunk for a node with one ``DELETE WHERE node_id = ?`` predicate.

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
from typing import Iterable

import lancedb
import pyarrow as pa

EMBEDDING_DIMENSION = 768
TABLE_NAME = "nodes"


@dataclass(frozen=True)
class NodeChunk:
    """One row in the ``nodes`` table — a single chunk of one node's content."""

    id: str
    node_id: str
    kind: str
    name: str
    text: str
    vector: list[float]  # length must be EMBEDDING_DIMENSION
    mount_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    modified_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if len(self.vector) != EMBEDDING_DIMENSION:
            raise ValueError(
                f"vector length {len(self.vector)} != {EMBEDDING_DIMENSION}"
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
        ]
    )


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

    def delete_by_node_ids(self, node_ids: Iterable[str]) -> None:
        ids = [i for i in node_ids if i]
        if not ids:
            return
        in_clause = ", ".join(f"'{_quote(i)}'" for i in ids)
        self._table.delete(f"node_id IN ({in_clause})")

    def count(self) -> int:
        """Total row count across all nodes."""
        return self._table.count_rows()

    def list_node_ids(self) -> set[str]:
        """The distinct ``node_id`` values currently in the table.

        Used by the resync flow (``POST /events/resync``) to compute
        the diff between Rust's authoritative node-id set and the
        sidecar's index.
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


def open_store(path: Path) -> LanceDBStore:
    """Open or create the lancedb store at ``path``.

    The first call creates an empty ``nodes`` table with the schema
    declared at module level. Subsequent calls open the existing
    table; if its schema diverges from ours, lancedb raises (caller
    should treat that as a re-index trigger — Unit 6 wires that flow).
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
    return LanceDBStore(db, table)


def _quote(value: str) -> str:
    """Escape single quotes for inclusion in a lancedb WHERE clause.

    lancedb's Python API does not currently expose parameterised
    predicates; this is the SEC-FINDING-005 mitigation in lieu of one.
    Caller is still responsible for validating the value's *shape*
    (e.g. node_id as UUID) before this is called.
    """
    return value.replace("'", "''")
