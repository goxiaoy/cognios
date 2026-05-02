"""Persistent storage primitives.

``lancedb_store`` is the authoritative table the indexing pipeline
writes to and the retrieval orchestrator reads from. Per the plan's
Unit 5/6 split, the schema + upsert + delete shipped here are
imported by Unit 5's processors; Unit 6 layers FTS + vector indexes
and hybrid retrieval on top of the same table.
"""

from .lancedb_store import (
    EMBEDDING_DIMENSION,
    ROLE_VALUES,
    LanceDBStore,
    NodeChunk,
    open_store,
    role_or_default,
)

__all__ = [
    "EMBEDDING_DIMENSION",
    "ROLE_VALUES",
    "LanceDBStore",
    "NodeChunk",
    "open_store",
    "role_or_default",
]
