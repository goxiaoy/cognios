"""LanceDB persistence layer."""

from __future__ import annotations

from pathlib import Path

import pytest

from search_sidecar.storage import (
    EMBEDDING_DIMENSION,
    NodeChunk,
    open_store,
)


def _make_chunk(node_id: str, idx: int = 0, text: str = "hello") -> NodeChunk:
    return NodeChunk(
        id=f"{node_id}:{idx}",
        node_id=node_id,
        kind="note",
        name="A note",
        text=text,
        vector=[0.0] * EMBEDDING_DIMENSION,
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


def test_open_store_is_idempotent(tmp_path: Path):
    path = tmp_path / "index.lance"
    open_store(path).upsert([_make_chunk("node-a")])
    reopened = open_store(path)
    assert reopened.count() == 1
