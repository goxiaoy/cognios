"""LanceDB persistence layer."""

from __future__ import annotations

from pathlib import Path

import lancedb
import pyarrow as pa
import pytest

from search_sidecar.storage import (
    EMBEDDING_DIMENSION,
    NodeChunk,
    open_store,
    role_or_default,
)
from search_sidecar.storage.lancedb_store import LanceDBStore, TABLE_NAME


def _make_chunk(
    node_id: str,
    idx: int = 0,
    text: str = "hello",
    *,
    role: str = "body",
) -> NodeChunk:
    return NodeChunk(
        id=f"{node_id}:{idx}",
        node_id=node_id,
        kind="note",
        name="A note",
        text=text,
        vector=[0.0] * EMBEDDING_DIMENSION,
        role=role,
    )


def test_open_store_creates_empty_table(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    assert store.count() == 0


def test_upsert_round_trips_chunks(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    chunks = [
        _make_chunk("node-a", idx=0, text="first chunk"),
        _make_chunk("node-a", idx=1, text="second chunk"),
        _make_chunk("node-b", idx=0, text="b's only chunk"),
    ]
    written = store.upsert(chunks)
    assert written == 3
    assert store.count() == 3
    assert store.list_node_ids() == {"node-a", "node-b"}


def test_upsert_replaces_existing_id(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert([_make_chunk("node-a", idx=0, text="original")])
    store.upsert([_make_chunk("node-a", idx=0, text="replacement")])
    assert store.count() == 1
    rows = store.scan("node-a")
    assert rows[0]["text"] == "replacement"


def test_delete_by_node_id_removes_all_chunks(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0),
            _make_chunk("node-a", idx=1),
            _make_chunk("node-a", idx=2),
            _make_chunk("node-b", idx=0),
        ]
    )
    store.delete_by_node_id("node-a")
    assert store.count() == 1
    assert store.list_node_ids() == {"node-b"}


def test_delete_chunks_by_role_preserves_summary(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0, text="body 0", role="body"),
            _make_chunk("node-a", idx=1, text="body 1", role="body"),
            _make_chunk("node-a", idx=2, text="body 2", role="body"),
            NodeChunk(
                id="node-a:summary:0",
                node_id="node-a",
                kind="file",
                name="img",
                text="caption",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="summary",
            ),
        ]
    )
    store.delete_chunks_by_role("node-a", "body")
    rows = store.scan("node-a")
    assert len(rows) == 1
    assert role_or_default(rows[0]) == "summary"
    assert rows[0]["text"] == "caption"


def test_delete_chunks_by_role_is_noop_for_missing_role(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert([_make_chunk("node-a", idx=0, role="body")])
    store.delete_chunks_by_role("node-a", "summary")
    assert store.count() == 1


def test_delete_chunks_by_role_does_not_touch_other_nodes(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0, role="body"),
            _make_chunk("node-b", idx=0, role="body"),
        ]
    )
    store.delete_chunks_by_role("node-a", "body")
    assert store.list_node_ids() == {"node-b"}


def test_delete_chunks_by_role_escapes_node_id(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    bad_id = "x' OR 1=1; --"
    store.upsert(
        [
            NodeChunk(
                id=f"{bad_id}:0",
                node_id=bad_id,
                kind="file",
                name="bad",
                text="bad body",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="body",
            ),
            _make_chunk("node-b", idx=0, role="body"),
        ]
    )
    store.delete_chunks_by_role(bad_id, "body")
    rows = store.scan("node-b")
    assert len(rows) == 1
    assert store.list_node_ids() == {"node-b"}


def test_delete_by_node_ids_handles_empty_input(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert([_make_chunk("node-a")])
    store.delete_by_node_ids([])  # no-op
    assert store.count() == 1


def test_node_chunk_rejects_wrong_dimension():
    with pytest.raises(ValueError, match="vector length"):
        NodeChunk(
            id="x:0",
            node_id="x",
            kind="note",
            name="x",
            text="x",
            vector=[0.0] * 16,  # too short
        )


def test_node_chunk_with_single_quote_in_id_does_not_break_delete(tmp_path: Path):
    """SEC-FINDING-005: even if a malicious id sneaks past upstream
    validation, the WHERE escape prevents predicate-injection."""
    store = open_store(tmp_path / "index.lance")
    bad_id = "evil' OR 1=1 --"
    chunk = NodeChunk(
        id=f"{bad_id}:0",
        node_id=bad_id,
        kind="note",
        name="evil",
        text="x",
        vector=[0.0] * EMBEDDING_DIMENSION,
    )
    store.upsert([chunk])
    assert store.count() == 1
    store.delete_by_node_id(bad_id)
    assert store.count() == 0


def test_hybrid_search_rejects_wrong_dim_query_vec(tmp_path: Path):
    """``hybrid_search`` validates the query vector at the boundary
    so a downstream lancedb shape-mismatch error never reaches the
    user."""
    store = open_store(tmp_path / "index.lance")
    with pytest.raises(ValueError, match="!= 768"):
        store.hybrid_search("oauth", [0.0] * 100)


def test_hybrid_search_returns_empty_for_blank_query(tmp_path: Path):
    """Mirrors ``fts_search``'s blank-query short-circuit so the
    orchestrator's ``parsed.text == ""`` case skips the round trip
    cleanly."""
    store = open_store(tmp_path / "index.lance")
    assert (
        store.hybrid_search("   ", [0.0] * EMBEDDING_DIMENSION) == []
    )


def test_hybrid_search_returns_empty_for_empty_table(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    assert (
        store.hybrid_search("oauth", [0.0] * EMBEDDING_DIMENSION) == []
    )


def test_hybrid_search_uses_explicit_vector_and_text_query():
    class FakeHybridBuilder:
        def __init__(self) -> None:
            self.vector_query: list[float] | None = None
            self.text_query: str | None = None
            self.limit_value: int | None = None

        def vector(self, query_vec: list[float]):
            self.vector_query = query_vec
            return self

        def text(self, query: str):
            self.text_query = query
            return self

        def limit(self, limit: int):
            self.limit_value = limit
            return self

        def to_list(self):
            return [
                {
                    "text": self.text_query,
                    "vector": self.vector_query,
                    "limit": self.limit_value,
                }
            ]

    class FakeTable:
        def __init__(self) -> None:
            self.builder = FakeHybridBuilder()
            self.search_calls: list[tuple[object, str]] = []

        def count_rows(self) -> int:
            return 1

        def create_fts_index(self, *_args, **_kwargs) -> None:
            return None

        def search(self, query=None, *, query_type="auto"):
            self.search_calls.append((query, query_type))
            return self.builder

    table = FakeTable()
    store = LanceDBStore(None, table)
    query_vec = [0.0] * EMBEDDING_DIMENSION

    rows = store.hybrid_search("oauth", query_vec, limit=5)

    assert table.search_calls == [(None, "hybrid")]
    assert rows == [{"text": "oauth", "vector": query_vec, "limit": 5}]


def test_find_stale_chunks_returns_only_zero_vector_rows(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-stale", idx=0, text="stub-era"),
            NodeChunk(
                id="node-real:0",
                node_id="node-real",
                kind="note",
                name="real",
                text="indexed under a real embedder",
                vector=[0.0] * (EMBEDDING_DIMENSION - 1) + [1.0],
            ),
        ]
    )
    stale = store.find_stale_chunks()
    assert len(stale) == 1
    assert stale[0]["id"] == "node-stale:0"


def test_find_stale_chunks_returns_empty_for_empty_table(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    assert store.find_stale_chunks() == []


def test_replace_rows_swaps_vectors_in_place(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0, text="hello"),
            _make_chunk("node-a", idx=1, text="world"),
        ]
    )
    stale = store.find_stale_chunks()
    new_vec = [0.0] * (EMBEDDING_DIMENSION - 1) + [1.0]
    updated = [{**row, "vector": new_vec} for row in stale]

    written = store.replace_rows(updated)
    assert written == 2
    # No new rows added; in-place swap.
    assert store.count() == 2
    # The "stale" set is now empty.
    assert store.find_stale_chunks() == []


def test_replace_rows_handles_empty_input(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    assert store.replace_rows([]) == 0


def test_open_store_is_idempotent(tmp_path: Path):
    path = tmp_path / "index.lance"
    open_store(path).upsert([_make_chunk("node-a")])
    reopened = open_store(path)
    assert reopened.count() == 1


def test_open_store_includes_role_column(tmp_path: Path):
    """Schema includes the role column on a fresh store."""
    store = open_store(tmp_path / "index.lance")
    assert "role" in store.table.schema.names


def test_upsert_round_trips_role(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0, text="body chunk", role="body"),
            NodeChunk(
                id="node-a:summary:0",
                node_id="node-a",
                kind="file",
                name="img",
                text="caption",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="summary",
            ),
        ]
    )
    rows = store.scan("node-a")
    by_id = {row["id"]: row for row in rows}
    assert by_id["node-a:0"]["role"] == "body"
    assert by_id["node-a:summary:0"]["role"] == "summary"


def test_node_chunk_rejects_unknown_role():
    with pytest.raises(ValueError, match="role"):
        NodeChunk(
            id="x:0",
            node_id="x",
            kind="note",
            name="x",
            text="x",
            vector=[0.0] * EMBEDDING_DIMENSION,
            role="caption",
        )


def test_role_or_default_handles_missing_and_null():
    assert role_or_default({}) == "body"
    assert role_or_default({"role": None}) == "body"
    assert role_or_default({"role": ""}) == "body"
    assert role_or_default({"role": "body"}) == "body"
    assert role_or_default({"role": "summary"}) == "summary"


def _legacy_schema() -> pa.Schema:
    """The pre-2026-05 schema — no ``role`` column."""
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


def test_open_store_migrates_legacy_table_in_place(tmp_path: Path):
    """A table created without ``role`` gets the column on next open;
    existing rows survive the migration and read as ``role="body"``."""
    from datetime import datetime, timezone

    path = tmp_path / "index.lance"
    path.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(path))
    legacy_table = db.create_table(TABLE_NAME, schema=_legacy_schema())
    now = datetime.now(timezone.utc)
    legacy_table.add(
        [
            {
                "id": "legacy-a:0",
                "node_id": "legacy-a",
                "kind": "note",
                "name": "old note",
                "text": "pre-schema content",
                "vector": [0.0] * EMBEDDING_DIMENSION,
                "mount_id": None,
                "created_at": now,
                "modified_at": now,
            }
        ]
    )

    store = open_store(path)
    assert "role" in store.table.schema.names
    rows = store.scan("legacy-a")
    assert len(rows) == 1
    # NULL on disk; role_or_default coerces to "body".
    assert role_or_default(rows[0]) == "body"


def test_open_store_migration_is_idempotent(tmp_path: Path):
    """Calling open_store twice doesn't raise on the second add_columns."""
    path = tmp_path / "index.lance"
    open_store(path)
    # Should not raise even though role already exists.
    store = open_store(path)
    assert "role" in store.table.schema.names


def test_replace_rows_preserves_role(tmp_path: Path):
    """find_stale_chunks → replace_rows round-trip keeps the role
    column intact (re-embed sweep contract)."""
    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            _make_chunk("node-a", idx=0, text="body", role="body"),
            NodeChunk(
                id="node-a:summary:0",
                node_id="node-a",
                kind="file",
                name="img",
                text="caption",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="summary",
            ),
        ]
    )
    stale = store.find_stale_chunks()
    new_vec = [0.0] * (EMBEDDING_DIMENSION - 1) + [1.0]
    updated = [{**row, "vector": new_vec} for row in stale]
    store.replace_rows(updated)

    rows = store.scan("node-a")
    by_id = {row["id"]: row for row in rows}
    assert role_or_default(by_id["node-a:0"]) == "body"
    assert role_or_default(by_id["node-a:summary:0"]) == "summary"
