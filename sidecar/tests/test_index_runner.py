from __future__ import annotations

from pathlib import Path

from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.storage import open_store

UUID_A = "11111111-1111-1111-1111-111111111111"


def _runner(tmp_path: Path) -> tuple[IndexingRunner, object]:
    store = open_store(tmp_path / "index.lance")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    return IndexingRunner(dispatcher=dispatcher), store


def test_process_direct_indexes_text_file(tmp_path: Path):
    runner, store = _runner(tmp_path)
    note = tmp_path / "note.md"
    note.write_text("hello direct indexing")

    result = runner.process_direct(
        node_id=UUID_A,
        kind="note",
        name="note.md",
        absolute_content_path=str(note),
    )

    assert result["status"] == "indexed"
    assert result["error"] is None
    assert store.count() == 2


def test_process_direct_returns_error_for_missing_file(tmp_path: Path):
    runner, store = _runner(tmp_path)

    result = runner.process_direct(
        node_id=UUID_A,
        kind="note",
        name="missing.md",
        absolute_content_path=str(tmp_path / "missing.md"),
    )

    assert result["status"] == "error"
    assert "FileNotFoundError" in result["error"]
    assert store.count() == 0


def test_process_direct_metadata_only_indexes_folder(tmp_path: Path):
    runner, store = _runner(tmp_path)

    result = runner.process_direct(
        node_id=UUID_A,
        kind="folder",
        name="Projects",
        absolute_content_path=None,
    )

    assert result["status"] == "indexed"
    rows = store.scan(UUID_A)
    assert len(rows) == 1
    assert rows[0]["role"] == "metadata"


def test_pause_blocks_direct_processing(tmp_path: Path):
    runner, _ = _runner(tmp_path)
    runner.set_paused(True)

    result = runner.process_direct(
        node_id=UUID_A,
        kind="folder",
        name="Projects",
    )

    assert result == {"status": "paused", "error": "indexing runner is paused"}
