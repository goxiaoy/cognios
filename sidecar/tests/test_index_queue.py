"""Persistent indexing queue (SQLite WAL)."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from search_sidecar.index.queue import (
    MAX_ENHANCEMENT_ATTEMPTS,
    JobState,
    open_queue,
)


def _enqueue_indexed_image(queue, node_id: str, name: str = "photo.png") -> None:
    """Test helper: enqueue an image and walk it through to indexed.

    The two-pass enhancement methods all assume a row is already in
    ``state='indexed'``; without this helper every enhancement test
    has the same 4-line preamble.
    """
    queue.enqueue(node_id=node_id, kind="file", name=name)
    job = queue.claim_next()
    assert job is not None and job.node_id == node_id
    queue.mark_indexed(node_id)


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


def test_non_forced_enqueue_does_not_rewind_indexed_same_version(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        modified_at = datetime(2026, 5, 8, tzinfo=timezone.utc)
        queue.enqueue(
            node_id="aaa",
            kind="note",
            name="A",
            modified_at=modified_at,
        )
        queue.claim_next()
        queue.mark_indexed("aaa")
        indexed = queue.get("aaa")
        assert indexed is not None
        indexed_seq = queue.peek_transition_seq("aaa")

        queue.enqueue(
            node_id="aaa",
            kind="note",
            name="A",
            modified_at=modified_at,
            force=False,
        )

        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.INDEXED
        assert fetched.indexed_at == indexed.indexed_at
        assert queue.peek_transition_seq("aaa") == indexed_seq
    finally:
        queue.close()


def test_non_forced_enqueue_new_content_version_requeues(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        first = datetime(2026, 5, 8, tzinfo=timezone.utc)
        second = datetime(2026, 5, 9, tzinfo=timezone.utc)
        queue.enqueue(node_id="aaa", kind="note", name="A", modified_at=first)
        queue.claim_next()
        queue.mark_indexed("aaa")

        queue.enqueue(
            node_id="aaa",
            kind="note",
            name="A",
            modified_at=second,
            force=False,
        )

        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.PENDING
        assert fetched.content_version == f"event:{second.isoformat()}"
    finally:
        queue.close()


def test_non_forced_container_metadata_update_does_not_requeue(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        first = datetime(2026, 5, 8, tzinfo=timezone.utc)
        second = datetime(2026, 5, 9, tzinfo=timezone.utc)
        queue.enqueue(node_id="aaa", kind="folder", name="A", modified_at=first)
        queue.claim_next()
        queue.mark_indexed("aaa")
        indexed_seq = queue.peek_transition_seq("aaa")

        queue.enqueue(
            node_id="aaa",
            kind="folder",
            name="A renamed",
            modified_at=second,
            force=False,
        )

        fetched = queue.get("aaa")
        assert fetched is not None
        assert fetched.state == JobState.INDEXED
        assert fetched.name == "A renamed"
        assert fetched.content_version == "container:folder"
        assert queue.peek_transition_seq("aaa") == indexed_seq
    finally:
        queue.close()


def test_mark_indexed_records_indexed_content_version(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        modified_at = datetime(2026, 5, 8, tzinfo=timezone.utc)
        queue.enqueue(node_id="aaa", kind="note", name="A", modified_at=modified_at)
        queue.claim_next()
        queue.mark_indexed("aaa")
        row = queue._conn.execute(  # noqa: SLF001 - white-box schema assertion.
            "SELECT content_version, indexed_content_version FROM jobs WHERE node_id='aaa'"
        ).fetchone()
        assert row["indexed_content_version"] == row["content_version"]
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



def test_changes_since_returns_only_new_transitions(tmp_path: Path):
    """Each state mutation bumps ``transition_seq`` and shows up
    exactly once in ``changes_since(prev_seq)``."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")  # seq 1
        queue.enqueue(node_id="bbb", kind="note", name="B")  # seq 2

        # Both rows visible from since=0
        transitions, next_seq = queue.changes_since(since=0, limit=10)
        ids = [t["node_id"] for t in transitions]
        assert ids == ["aaa", "bbb"]
        assert next_seq == 2
        assert all(t["state"] == "pending" for t in transitions)

        # Advancing past both transitions returns empty
        transitions, next_seq = queue.changes_since(since=next_seq, limit=10)
        assert transitions == []
        assert next_seq == 0

        # A new transition (claim then mark_indexed) shows up
        cursor = 2
        queue.claim_next()  # bumps "aaa" to indexing, seq 3
        queue.mark_indexed("aaa")  # seq 4
        transitions, next_seq = queue.changes_since(since=cursor, limit=10)
        # Only the latest state per node is stored — we see "indexed"
        # (seq 4), not "indexing" (seq 3).
        assert len(transitions) == 1
        assert transitions[0]["node_id"] == "aaa"
        assert transitions[0]["state"] == "indexed"
        assert next_seq == 4
    finally:
        queue.close()


def test_changes_since_paginates_via_limit(tmp_path: Path):
    """Caller advancing through chunks must not lose transitions
    when more rows share the cursor boundary than ``limit`` allows."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        for i in range(5):
            queue.enqueue(node_id=f"id-{i}", kind="note", name=f"n{i}")
        # First page
        page1, max1 = queue.changes_since(since=0, limit=2)
        assert len(page1) == 2
        # Second page
        page2, max2 = queue.changes_since(since=max1, limit=2)
        assert len(page2) == 2
        # Third page
        page3, max3 = queue.changes_since(since=max2, limit=2)
        assert len(page3) == 1
        seen = [t["node_id"] for t in page1 + page2 + page3]
        assert seen == [f"id-{i}" for i in range(5)]
        # Drain
        empty, _ = queue.changes_since(since=max3, limit=2)
        assert empty == []
    finally:
        queue.close()


def test_reset_stale_indexing_emits_distinct_transitions(tmp_path: Path):
    """Restored "indexing → pending" rows must each get a unique seq
    so the Rust poll never collapses them into one transition."""
    db_path = tmp_path / "queue.db"
    queue = open_queue(db_path)
    try:
        for i in range(3):
            queue.enqueue(node_id=f"id-{i}", kind="note", name=f"n{i}")
            queue.claim_next()
        head = queue.head_seq()
    finally:
        queue.close()

    queue = open_queue(db_path)  # reset_stale_indexing fires here
    try:
        transitions, _ = queue.changes_since(since=head, limit=10)
        assert len(transitions) == 3
        seqs = [t["transition_seq"] for t in transitions]
        assert len(set(seqs)) == 3, f"duplicate seqs: {seqs}"
        assert all(t["state"] == "pending" for t in transitions)
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


# ----- two-pass image OCR enhancement -----------------------------------


def _columns(queue) -> set[str]:
    return {
        row[1]
        for row in queue._conn.execute("PRAGMA table_info(jobs)").fetchall()
    }


def test_fresh_schema_includes_enhancement_columns(tmp_path: Path):
    """A new queue.db has all enhancement columns."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        cols = _columns(queue)
        assert "enhancement_pending" in cols
        assert "enhancement_attempts" in cols
        assert "enhancement_failed" in cols
        assert "enhancement_completed_at" in cols
    finally:
        queue.close()


def test_legacy_queue_db_gets_enhancement_columns_idempotently(tmp_path: Path):
    """Open a queue.db that predates the enhancement columns — the
    migration adds them at default 0 without disturbing existing rows
    or running twice."""
    db_path = tmp_path / "queue.db"
    # Hand-craft a legacy schema (no enhancement columns) and seed a
    # row so we can verify the migration preserves data.
    raw = sqlite3.connect(db_path, isolation_level=None)
    try:
        raw.execute("PRAGMA journal_mode=WAL")
        raw.executescript(
            """
            CREATE TABLE jobs (
                node_id               TEXT PRIMARY KEY,
                kind                  TEXT NOT NULL,
                name                  TEXT NOT NULL,
                absolute_content_path TEXT,
                mount_id              TEXT,
                state                 TEXT NOT NULL,
                enqueued_at           TEXT NOT NULL,
                indexed_at            TEXT,
                last_error            TEXT,
                attempts              INTEGER NOT NULL DEFAULT 0,
                created_at            TEXT NOT NULL,
                modified_at           TEXT NOT NULL,
                transition_seq        INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO jobs (
                node_id, kind, name, state, enqueued_at,
                created_at, modified_at, transition_seq
            ) VALUES (
                'legacy-1', 'file', 'old.png', 'indexed', '2026-05-01T00:00:00+00:00',
                '2026-05-01T00:00:00+00:00', '2026-05-01T00:00:00+00:00', 1
            );
            """
        )
    finally:
        raw.close()

    # Open via the production path — migration should run.
    queue = open_queue(db_path)
    try:
        cols = _columns(queue)
        assert {
            "enhancement_pending",
            "enhancement_attempts",
            "enhancement_failed",
            "enhancement_completed_at",
        } <= cols
        row = queue._conn.execute(
            """
            SELECT enhancement_pending, enhancement_attempts,
                   enhancement_failed, enhancement_completed_at
            FROM jobs WHERE node_id = 'legacy-1'
            """
        ).fetchone()
        assert tuple(row) == (0, 0, 0, None)
    finally:
        queue.close()

    # Re-open: migration must be idempotent (no errors, no duplicate columns).
    queue2 = open_queue(db_path)
    try:
        assert "enhancement_pending" in _columns(queue2)
        assert "enhancement_completed_at" in _columns(queue2)
    finally:
        queue2.close()


def test_set_and_clear_enhancement_pending_round_trip(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")

        queue.set_enhancement_pending("img-1")
        result = queue.claim_next_enhancement()
        assert result is not None
        job, claim_seq = result
        assert job.node_id == "img-1"
        assert claim_seq > 0  # transition_seq from the indexed transition

        # Idempotent re-flag: call set_enhancement_pending again, still claimable.
        queue.set_enhancement_pending("img-1")
        again = queue.claim_next_enhancement()
        assert again is not None and again[0].node_id == "img-1"

        queue.clear_enhancement_pending("img-1")
        assert queue.claim_next_enhancement() is None
        row = queue._conn.execute(
            """
            SELECT enhancement_pending, enhancement_completed_at
            FROM jobs WHERE node_id = 'img-1'
            """
        ).fetchone()
        assert row["enhancement_pending"] == 0
        assert row["enhancement_completed_at"] is not None
    finally:
        queue.close()


def test_set_enhancement_pending_refuses_completed_rows(tmp_path: Path):
    """A completed advanced pass should not be re-armed unless enqueue
    records a new file version."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        queue.clear_enhancement_pending("img-1")

        queue.set_enhancement_pending("img-1")
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_claim_next_enhancement_orders_by_indexed_at(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        # Index in order img-1 then img-2; both flagged.
        _enqueue_indexed_image(queue, "img-1")
        _enqueue_indexed_image(queue, "img-2")
        queue.set_enhancement_pending("img-1")
        queue.set_enhancement_pending("img-2")

        first = queue.claim_next_enhancement()
        assert first is not None and first[0].node_id == "img-1"
        # claim_next_enhancement does NOT mutate state, so img-1 stays
        # claimable until clear or fail.
        queue.clear_enhancement_pending("img-1")

        second = queue.claim_next_enhancement()
        assert second is not None and second[0].node_id == "img-2"
    finally:
        queue.close()


def test_claim_next_enhancement_skips_pending_state_rows(tmp_path: Path):
    """A row in state='pending' (basic pass not yet done) must NOT be
    eligible for enhancement claim, even if some other code path
    accidentally set the flag."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="img-pending", kind="file", name="x.png")
        # Force-set the bit while still pending. This can happen during
        # the basic pass before the runner records indexed; the claim
        # predicate must still wait for state='indexed'.
        queue._conn.execute(
            "UPDATE jobs SET enhancement_pending = 1 WHERE node_id = ?",
            ("img-pending",),
        )
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_claim_next_enhancement_skips_failed_rows(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        queue.mark_enhancement_failed("img-1")
        # mark_enhancement_failed also clears pending; even if a buggy
        # caller re-flagged it, the failed=1 sentinel must dominate.
        queue._conn.execute(
            "UPDATE jobs SET enhancement_pending = 1 WHERE node_id = 'img-1'"
        )
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_claim_next_enhancement_skips_cap_exhausted_rows(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        for _ in range(MAX_ENHANCEMENT_ATTEMPTS):
            queue.bump_enhancement_attempts("img-1")
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_set_enhancement_pending_refuses_failed_rows(tmp_path: Path):
    """The basic-pass completion handler must not be able to re-arm a
    row the runner has already terminally failed. Only ``enqueue``
    (file mod) clears the failed bit."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.mark_enhancement_failed("img-1")
        queue.set_enhancement_pending("img-1")  # should be no-op
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_mark_enhancement_failed_clears_pending(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        queue.mark_enhancement_failed("img-1")
        row = queue._conn.execute(
            "SELECT enhancement_pending, enhancement_failed FROM jobs WHERE node_id='img-1'"
        ).fetchone()
        assert tuple(row) == (0, 1)
    finally:
        queue.close()


def test_bump_enhancement_attempts_returns_new_count(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        assert queue.bump_enhancement_attempts("img-1") == 1
        assert queue.bump_enhancement_attempts("img-1") == 2
        assert queue.bump_enhancement_attempts("img-1") == 3
    finally:
        queue.close()


def test_bump_enhancement_attempts_unknown_node_returns_zero(tmp_path: Path):
    """A node that no longer exists shouldn't crash the caller; the
    runner is single-threaded but the row could have been deleted by
    the deletion path between claim and bump."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        assert queue.bump_enhancement_attempts("does-not-exist") == 0
    finally:
        queue.close()


def test_peek_transition_seq_reads_current_value(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        seq_before = queue.peek_transition_seq("img-1")
        assert seq_before is not None and seq_before > 0
        # mark_indexed bumps seq again on a re-mark, but the public
        # contract says the value advances on any state mutation.
        # Use enqueue (revives the row to pending) to advance it.
        queue.enqueue(node_id="img-1", kind="file", name="photo.png")
        seq_after = queue.peek_transition_seq("img-1")
        assert seq_after is not None and seq_after > seq_before
    finally:
        queue.close()


def test_peek_transition_seq_returns_none_for_missing_row(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        assert queue.peek_transition_seq("nope") is None
    finally:
        queue.close()


def test_clear_pending_if_transition_seq_is_atomic(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        seq = queue.peek_transition_seq("img-1")
        assert seq is not None

        assert queue.clear_enhancement_pending_if_transition_seq(
            "img-1", seq + 1
        ) is False
        assert queue.claim_next_enhancement() is not None

        assert queue.clear_enhancement_pending_if_transition_seq(
            "img-1", seq
        ) is True
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_enqueue_resets_enhancement_bookkeeping(tmp_path: Path):
    """File mod (or user-triggered Reindex) must wipe the enhancement
    bookkeeping so the basic+enhancement cycle re-runs fresh, even
    re-arming a previously completed or cap-exhausted row."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1")
        queue.set_enhancement_pending("img-1")
        queue.clear_enhancement_pending("img-1")
        queue.set_enhancement_pending("img-1")  # completed row, should no-op
        queue.bump_enhancement_attempts("img-1")
        queue.bump_enhancement_attempts("img-1")
        queue.mark_enhancement_failed("img-1")
        # Now simulate a file modification — should reset all enhancement
        # bookkeeping, including the completed marker.
        queue.enqueue(node_id="img-1", kind="file", name="photo.png")
        row = queue._conn.execute(
            """
            SELECT enhancement_pending, enhancement_attempts,
                   enhancement_failed, enhancement_completed_at
            FROM jobs WHERE node_id = 'img-1'
            """
        ).fetchone()
        assert tuple(row) == (0, 0, 0, None)
    finally:
        queue.close()


def test_backfill_enhancement_pending_flags_only_eligible_images(tmp_path: Path):
    """``backfill_enhancement_pending`` flags indexed images by suffix
    while skipping already-pending, already-completed, failed,
    cap-exhausted, non-image, and non-indexed rows."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-png", "photo.png")
        _enqueue_indexed_image(queue, "img-jpg", "scan.JPG")  # case-insensitive
        _enqueue_indexed_image(queue, "img-pdf", "doc.pdf")  # not an image
        _enqueue_indexed_image(queue, "img-already", "ready.png")
        queue.set_enhancement_pending("img-already")  # already flagged
        _enqueue_indexed_image(queue, "img-completed", "done.png")
        queue.set_enhancement_pending("img-completed")
        queue.clear_enhancement_pending("img-completed")
        _enqueue_indexed_image(queue, "img-failed", "broken.png")
        queue.mark_enhancement_failed("img-failed")  # terminally failed
        # Enqueue this last so the helper's intermediate claim_next
        # calls don't accidentally pick it up before reaching its
        # corresponding image — it stays in 'pending' state.
        queue.enqueue(node_id="img-pending", kind="file", name="other.png")

        flagged = queue.backfill_enhancement_pending(("png", "jpg"))
        # img-png + img-jpg = 2; the other rows are skipped.
        assert flagged == 2

        # Idempotent: a second call flags zero new rows.
        assert queue.backfill_enhancement_pending(("png", "jpg")) == 0
    finally:
        queue.close()


def test_backfill_excludes_terminally_failed_rows_across_restart(
    tmp_path: Path,
):
    """Closes the cap-exhaust re-flag loop: after a row is terminally
    failed, no number of watcher transitions or sidecar restarts can
    re-arm it. Only ``enqueue`` clears the failed bit."""
    db_path = tmp_path / "queue.db"
    queue = open_queue(db_path)
    try:
        _enqueue_indexed_image(queue, "img-1", "x.png")
        queue.set_enhancement_pending("img-1")
        queue.mark_enhancement_failed("img-1")
    finally:
        queue.close()

    # Simulate sidecar restart: re-open the same on-disk file.
    queue2 = open_queue(db_path)
    try:
        flagged = queue2.backfill_enhancement_pending(("png",))
        assert flagged == 0
        assert queue2.claim_next_enhancement() is None
    finally:
        queue2.close()


def test_backfill_excludes_completed_rows_across_restart(tmp_path: Path):
    """After advanced OCR completes, boot backfill should not requeue
    the image again unless a later enqueue records changed content."""
    db_path = tmp_path / "queue.db"
    queue = open_queue(db_path)
    try:
        _enqueue_indexed_image(queue, "img-1", "x.png")
        queue.set_enhancement_pending("img-1")
        queue.clear_enhancement_pending("img-1")
    finally:
        queue.close()

    queue2 = open_queue(db_path)
    try:
        assert queue2.backfill_enhancement_pending(("png",)) == 0
        assert queue2.claim_next_enhancement() is None

        queue2.enqueue(node_id="img-1", kind="file", name="x.png")
        job = queue2.claim_next()
        assert job is not None
        queue2.mark_indexed("img-1")
        assert queue2.backfill_enhancement_pending(("png",)) == 1
        assert queue2.claim_next_enhancement() is not None
    finally:
        queue2.close()


def test_count_helpers_split_pending_failed_total(tmp_path: Path):
    """The diagnostics counter relies on these three counts to render
    'enhanced / total' alongside a separate 'failed' indicator."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-pending", "a.png")
        queue.set_enhancement_pending("img-pending")
        _enqueue_indexed_image(queue, "img-done", "b.png")
        # img-done leaves all enhancement fields at 0 (success path).
        _enqueue_indexed_image(queue, "img-failed", "c.png")
        queue.mark_enhancement_failed("img-failed")
        # Non-image: must NOT count toward total.
        _enqueue_indexed_image(queue, "doc-1", "notes.pdf")

        assert queue.count_enhancement_pending() == 1
        assert queue.count_enhancement_failed() == 1
        assert queue.count_enhancement_eligible_total(("png",)) == 3
    finally:
        queue.close()


def test_backfill_with_no_extensions_returns_zero(tmp_path: Path):
    """Defensive: empty extension tuple short-circuits without
    constructing an empty SQL clause that would match every file."""
    queue = open_queue(tmp_path / "queue.db")
    try:
        _enqueue_indexed_image(queue, "img-1", "x.png")
        assert queue.backfill_enhancement_pending(()) == 0
        assert queue.count_enhancement_eligible_total(()) == 0
    finally:
        queue.close()
