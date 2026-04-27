"""Re-embed sweep — upgrades stub-vector chunks to real embeddings."""

from __future__ import annotations

from pathlib import Path

from search_sidecar.embeddings.reembed import (
    ReembedSummary,
    reembed_stale_chunks,
)
from search_sidecar.index.processors.text import TextProcessor
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.storage import EMBEDDING_DIMENSION, open_store

UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


class FakeSemanticEmbedder:
    """Test double for a real embedder. Returns a non-zero vector
    derived from the input text length so each chunk gets a unique
    vector — lets the sweep's "all zero → real vector" transition be
    asserted unambiguously."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    @property
    def dimension(self) -> int:
        return EMBEDDING_DIMENSION

    @property
    def is_semantic(self) -> bool:
        return True

    def embed(self, texts):
        materialised = [t for t in texts]
        self.calls.append(list(materialised))
        out: list[list[float]] = []
        for t in materialised:
            # Distinct first byte per text so we can assert uniqueness
            # across rows; remainder is constant non-zero so the vector
            # is unambiguously not the stub.
            seed = (len(t) % 200) / 100.0 + 0.1
            vec = [seed] + [0.5] * (EMBEDDING_DIMENSION - 1)
            out.append(vec)
        return out


class BrokenEmbedder(FakeSemanticEmbedder):
    """Always raises. Used to assert the sweep doesn't kill itself
    on a transient model fault."""

    def embed(self, texts):
        raise RuntimeError("onnxruntime crashed")


def _make_job(path: Path, *, node_id: str) -> IndexingJob:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    return IndexingJob(
        node_id=node_id,
        kind="note",
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


def test_sweep_replaces_zero_vectors_with_real_vectors(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())

    note_a = tmp_path / "a.md"
    note_a.write_text("the quick brown fox")
    proc.process(_make_job(note_a, node_id=UUID_A))

    assert len(store.find_stale_chunks()) > 0
    embedder = FakeSemanticEmbedder()
    summary = reembed_stale_chunks(store, embedder, batch_size=8)

    assert summary.updated > 0
    assert summary.examined == summary.updated
    # Every chunk now has a non-zero vector, so the sweep is idempotent
    # — the next call has nothing to do.
    assert store.find_stale_chunks() == []
    second = reembed_stale_chunks(store, embedder)
    assert second == ReembedSummary(examined=0, updated=0, skipped=0)


def test_sweep_skips_when_embedder_is_not_semantic(tmp_path: Path):
    """If the caller passes a stub embedder by mistake the sweep must
    not corrupt existing rows by replacing them with another zero
    vector."""
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    note = tmp_path / "a.md"
    note.write_text("hello world")
    proc.process(_make_job(note, node_id=UUID_A))

    initial_stale = len(store.find_stale_chunks())
    summary = reembed_stale_chunks(store, StubEmbedder())

    assert summary == ReembedSummary(examined=0, updated=0, skipped=0)
    # No row was rewritten.
    assert len(store.find_stale_chunks()) == initial_stale


def test_sweep_continues_after_a_batch_fails(tmp_path: Path):
    """A single failed batch must not abort the sweep — log and
    continue. Empty corpus is OK; we just want to assert no exception
    leaks out."""
    store = open_store(tmp_path / "index.lance")
    proc = TextProcessor(store, StubEmbedder())
    note = tmp_path / "a.md"
    note.write_text("hello world")
    proc.process(_make_job(note, node_id=UUID_A))

    summary = reembed_stale_chunks(store, BrokenEmbedder())
    # All embedable chunks were attempted; all skipped due to crash.
    assert summary.updated == 0
    assert summary.skipped > 0
    # No row was ever rewritten so the stale set is unchanged.
    assert len(store.find_stale_chunks()) == summary.examined


def test_sweep_skips_chunks_with_empty_text(tmp_path: Path):
    """Pathological row with empty ``text`` (shouldn't ever happen,
    but be defensive) is skipped, not embedded against an empty
    string."""
    from search_sidecar.storage import NodeChunk

    store = open_store(tmp_path / "index.lance")
    store.upsert(
        [
            NodeChunk(
                id=f"{UUID_B}:0",
                node_id=UUID_B,
                kind="note",
                name="empty",
                text="",
                vector=[0.0] * EMBEDDING_DIMENSION,
            )
        ]
    )
    embedder = FakeSemanticEmbedder()
    summary = reembed_stale_chunks(store, embedder)
    assert summary.updated == 0
    assert summary.skipped == 1
    # The empty-text row is left as-is (still stub vector) rather than
    # corrupted with an embedding of "".
    assert len(store.find_stale_chunks()) == 1
    assert embedder.calls == []
