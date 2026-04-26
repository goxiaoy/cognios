"""Indexing runner — drains the queue, isolates errors per job."""

from __future__ import annotations

import time
from pathlib import Path

from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.queue import JobState, open_queue
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.storage import open_store

UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


def _make_setup(tmp_path: Path) -> tuple:
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    runner = IndexingRunner(queue=queue, dispatcher=dispatcher)
    return store, queue, runner


def test_process_one_returns_false_when_empty(tmp_path: Path):
    _, queue, runner = _make_setup(tmp_path)
    try:
        assert runner.process_one() is False
    finally:
        queue.close()


def test_process_one_drains_a_text_job(tmp_path: Path):
    store, queue, runner = _make_setup(tmp_path)
    try:
        note = tmp_path / "note.md"
        note.write_text("hello world\n\nsecond paragraph")
        queue.enqueue(
            node_id=UUID_A,
            kind="note",
            name="note.md",
            absolute_content_path=str(note),
        )
        assert runner.process_one() is True
        job = queue.get(UUID_A)
        assert job is not None
        assert job.state == JobState.INDEXED
        assert store.count() == 2
    finally:
        queue.close()


def test_process_one_marks_error_on_processor_exception(tmp_path: Path):
    """Pointing the job at a missing file triggers FileNotFoundError
    inside the processor; the runner catches it and marks_error rather
    than crashing or leaking the indexing state."""
    _, queue, runner = _make_setup(tmp_path)
    try:
        queue.enqueue(
            node_id=UUID_A,
            kind="note",
            name="absent.md",
            absolute_content_path=str(tmp_path / "absent.md"),
        )
        assert runner.process_one() is True
        job = queue.get(UUID_A)
        assert job is not None
        assert job.state == JobState.ERROR
        assert "FileNotFoundError" in (job.last_error or "")
    finally:
        queue.close()


def test_process_one_marks_error_when_no_processor_matches(tmp_path: Path):
    """A folder-kind job has no matching processor; runner marks error
    rather than silently dropping it."""
    _, queue, runner = _make_setup(tmp_path)
    try:
        queue.enqueue(node_id=UUID_A, kind="folder", name="Inbox")
        assert runner.process_one() is True
        job = queue.get(UUID_A)
        assert job is not None
        assert job.state == JobState.ERROR
        assert "no processor" in (job.last_error or "")
    finally:
        queue.close()


def test_runner_thread_drains_queue_in_background(tmp_path: Path):
    store, queue, runner = _make_setup(tmp_path)
    try:
        for uuid in (UUID_A, UUID_B):
            note = tmp_path / f"{uuid}.md"
            note.write_text(f"content for {uuid}")
            queue.enqueue(
                node_id=uuid,
                kind="note",
                name=note.name,
                absolute_content_path=str(note),
            )

        runner.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if queue.queue_depth() == 0 and queue.in_flight_node_ids() == []:
                break
            time.sleep(0.05)
        runner.stop()

        assert queue.queue_depth() == 0
        assert store.count() == 2
        for uuid in (UUID_A, UUID_B):
            j = queue.get(uuid)
            assert j is not None
            assert j.state == JobState.INDEXED
    finally:
        queue.close()


def test_one_bad_job_does_not_poison_the_queue(tmp_path: Path):
    """A failing job marks itself error; subsequent good jobs still
    drain. Plan invariant from the indexing-pipeline section."""
    store, queue, runner = _make_setup(tmp_path)
    try:
        good_note = tmp_path / "good.md"
        good_note.write_text("good content")

        # Bad job first, good job second
        queue.enqueue(
            node_id=UUID_A,
            kind="note",
            name="absent.md",
            absolute_content_path=str(tmp_path / "absent.md"),
        )
        queue.enqueue(
            node_id=UUID_B,
            kind="note",
            name="good.md",
            absolute_content_path=str(good_note),
        )

        assert runner.process_one() is True  # bad
        assert runner.process_one() is True  # good
        assert runner.process_one() is False  # empty

        bad = queue.get(UUID_A)
        good = queue.get(UUID_B)
        assert bad is not None and bad.state == JobState.ERROR
        assert good is not None and good.state == JobState.INDEXED
        assert store.count() == 1
    finally:
        queue.close()
