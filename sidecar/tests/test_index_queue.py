"""Persistent indexing queue (SQLite WAL)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from search_sidecar.index.queue import JobState, open_queue


def test_open_queue_creates_schema_and_pragmas(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        assert queue.queue_depth() == 0
    finally:
        queue.close()


def test_enqueue_then_claim_marks_indexing(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(
            node_id="aaa",
            kind="note",
            name="A",
            absolute_content_path="/tmp/a.md",
        )
        assert queue.queue_depth() == 1

        job = queue.claim_next()
        assert job is not None
        assert job.state == JobState.INDEXING
        assert job.attempts == 1

        # No more pending
        assert queue.claim_next() is None
        assert queue.queue_depth() == 0
        assert queue.in_flight_node_ids() == ["aaa"]
    finally:
        queue.close()


def test_mark_indexed_clears_in_flight(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        job = queue.claim_next()
        assert job is not None
        queue.mark_indexed(job.node_id)
        assert queue.in_flight_node_ids() == []
        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.INDEXED
        assert fetched.indexed_at is not None
    finally:
        queue.close()


def test_mark_error_truncates_long_messages(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        queue.claim_next()
        queue.mark_error("aaa", "x" * 2048)
        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.ERROR
        assert fetched.last_error is not None
        assert len(fetched.last_error) == 1024
    finally:
        queue.close()


def test_enqueue_revives_existing_row_to_pending(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        queue.claim_next()
        queue.mark_error("aaa", "boom")

        # New enqueue resets state to pending and clears the error
        queue.enqueue(node_id="aaa", kind="note", name="A renamed")
        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.PENDING
        assert fetched.last_error is None
        assert fetched.name == "A renamed"
    finally:
        queue.close()


def test_remove_returns_true_when_row_existed(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        assert queue.remove("aaa") is True
        assert queue.remove("aaa") is False
    finally:
        queue.close()


def test_reset_stale_indexing_runs_at_open(tmp_path: Path):
    """A row stuck in INDEXING (e.g. from a crashed runner) must be
    reset to PENDING when the queue reopens."""
    db_path = tmp_path / "queue.db"
    queue = open_queue(db_path)
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        queue.claim_next()
        assert queue.in_flight_node_ids() == ["aaa"]
    finally:
        queue.close()

    # Reopen — startup should reset
    queue = open_queue(db_path)
    try:
        assert queue.in_flight_node_ids() == []
        assert queue.queue_depth() == 1
    finally:
        queue.close()


def test_corrupt_db_is_renamed_and_recreated(tmp_path: Path):
    """A junk file at queue.db must not block startup."""
    db_path = tmp_path / "queue.db"
    db_path.write_bytes(b"not a sqlite database")
    queue = open_queue(db_path)
    try:
        assert queue.queue_depth() == 0
    finally:
        queue.close()
    # The corrupt file should have been renamed aside
    siblings = sorted(p.name for p in tmp_path.iterdir() if p.name.startswith("queue.db"))
    assert any("corrupt-" in name for name in siblings), siblings


def test_list_node_ids_returns_all_states(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        queue.enqueue(node_id="bbb", kind="note", name="B")
        queue.claim_next()
        queue.mark_indexed("aaa") if False else None  # noqa
        ids = queue.list_node_ids()
        assert ids == {"aaa", "bbb"}
    finally:
        queue.close()



def test_concurrent_reads_and_writes_never_return_none_from_count(
    tmp_path: Path,
):
    """Regression test for the runtime ``'NoneType' object is not
    subscriptable`` crash from ``queue_depth()`` when the FastAPI
    request thread races the runner's write loop on the same
    connection.

    Pre-fix, ``connection.execute("SELECT COUNT(*)").fetchone()``
    occasionally returned ``None`` because CPython sqlite3 doesn't
    serialize ``execute`` calls across threads when
    ``check_same_thread=False`` is set. The lock on IndexingQueue
    fixes this; this test asserts every queue_depth result is an
    integer under heavy concurrent load.
    """
    import threading

    queue = open_queue(tmp_path / "queue.db")
    try:
        stop = threading.Event()
        depth_results: list[object] = []
        errors: list[Exception] = []

        def writer():
            i = 0
            while not stop.is_set():
                try:
                    queue.enqueue(
                        node_id=f"node-{i % 50:04d}",
                        kind="note",
                        name=f"n{i}",
                    )
                except Exception as err:  # pragma: no cover
                    errors.append(err)
                i += 1

        def reader():
            while not stop.is_set():
                try:
                    depth_results.append(queue.queue_depth())
                except Exception as err:  # pragma: no cover
                    errors.append(err)

        threads = [
            threading.Thread(target=writer, daemon=True),
            threading.Thread(target=writer, daemon=True),
            threading.Thread(target=reader, daemon=True),
            threading.Thread(target=reader, daemon=True),
            threading.Thread(target=reader, daemon=True),
        ]
        for t in threads:
            t.start()
        # ~0.5s of contention is enough to surface the race deterministically
        # against the un-locked baseline; the locked version stays clean.
        threading.Event().wait(0.5)
        stop.set()
        for t in threads:
            t.join(timeout=2.0)

        assert errors == []
        assert len(depth_results) > 100
        for value in depth_results:
            assert isinstance(value, int), f"queue_depth returned {value!r}"
    finally:
        queue.close()
