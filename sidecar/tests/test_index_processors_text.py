"""Text processor: read → chunk → embed → upsert."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from search_sidecar.index.chunking import chunk_text as _chunk
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.text import TextProcessor
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.storage import open_store, role_or_default


def _make_job(path: Path, *, kind: str = "note", node_id: str = "11111111-1111-1111-1111-111111111111") -> IndexingJob:
    now = datetime.now(timezone.utc)
    return IndexingJob(
        node_id=node_id,
        kind=kind,
        name=path.name,
        absolute_content_path=str(path),
        mount_id=None,
        state=JobState.INDEXING,
        enqueued_at=now,
        indexed_at=None,
        last_error=None,
        attempts=1,
        created_at=now,
        modified_at=now,
    )


def test_can_handle_only_supported_extensions(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    md = tmp_path / "x.md"
    md.write_text("hi")
    txt = tmp_path / "x.txt"
    txt.write_text("hi")
    bin_ = tmp_path / "x.bin"
    bin_.write_text("hi")

    assert proc.can_handle(_make_job(md))
    assert proc.can_handle(_make_job(txt))
    assert not proc.can_handle(_make_job(bin_))


def test_can_handle_rejects_url_kind(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    md = tmp_path / "x.md"
    md.write_text("hi")
    assert not proc.can_handle(_make_job(md, kind="url"))


def test_process_writes_chunks_to_store(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    note = tmp_path / "note.md"
    note.write_text("# Heading\n\nThis is the first paragraph.\n\nAnd the second.")
    written = proc.process(_make_job(note))
    assert written == 3  # heading, first para, second para
    assert store.count() == 3
    rows = store.scan(_make_job(note).node_id)
    assert {role_or_default(r) for r in rows} == {"body"}


def test_process_replaces_previous_chunks_on_re_index(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    note = tmp_path / "note.md"
    job = _make_job(note)

    note.write_text("Original body.")
    proc.process(job)
    assert store.count() == 1

    note.write_text("Now this body has\n\ntwo paragraphs.")
    proc.process(job)
    # Old single chunk replaced with two new
    assert store.count() == 2


def test_process_handles_empty_file(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    note = tmp_path / "empty.md"
    note.write_text("   \n   ")
    written = proc.process(_make_job(note))
    assert written == 0
    assert store.count() == 0


def test_process_raises_when_file_missing(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    job = _make_job(tmp_path / "absent.md")
    with pytest.raises(FileNotFoundError):
        proc.process(job)


def test_chunk_splits_long_paragraphs():
    long_para = ("sentence one. " * 50).strip()
    chunks = _chunk(long_para)
    assert len(chunks) > 1
    for c in chunks:
        assert len(c) <= 512


def test_chunk_handles_chinese_terminators():
    text = "第一句。第二句！第三句？" * 30
    chunks = _chunk(text)
    assert chunks
    for c in chunks:
        assert len(c) <= 512


def test_chunk_hard_breaks_pathological_input():
    """A single sentence longer than the cap with no terminators must
    still produce chunks at the cap, not blow up."""
    long_text = "x" * (512 * 3 + 100)
    chunks = _chunk(long_text)
    assert len(chunks) >= 3
    for c in chunks:
        assert len(c) <= 512
