"""Image processor — exercises the OCR + caption extractor injection
points, the all-extractors-disabled fallback, and dispatcher routing.

Real paddleocr / llama-server integrations are out of scope for this
suite (they live behind optional deps + an external supervisor).
Tests inject simple Python callables to stand in for the real
extractors, which is exactly the contract the lifecycle layer will
use when those integrations land.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.image import ImageProcessor
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.storage import open_store

UUID_A = "11111111-1111-1111-1111-111111111111"


def _make_job(path: Path, *, node_id: str = UUID_A) -> IndexingJob:
    now = datetime.now(timezone.utc)
    return IndexingJob(
        node_id=node_id,
        kind="file",
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


@pytest.fixture
def store(tmp_path: Path):
    return open_store(tmp_path / "index.lance")


# ---- can_handle ------------------------------------------------------------


def test_can_handle_accepts_common_image_extensions(store, tmp_path: Path):
    proc = ImageProcessor(store, StubEmbedder())
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif"):
        path = tmp_path / f"x{ext}"
        path.write_bytes(b"")
        assert proc.can_handle(_make_job(path)) is True, f"failed for {ext}"


def test_can_handle_rejects_non_image_extensions(store, tmp_path: Path):
    proc = ImageProcessor(store, StubEmbedder())
    md = tmp_path / "x.md"
    md.write_bytes(b"")
    assert proc.can_handle(_make_job(md)) is False


def test_can_handle_rejects_note_kind(store, tmp_path: Path):
    proc = ImageProcessor(store, StubEmbedder())
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    job = _make_job(img)
    note_job = IndexingJob(**{**job.__dict__, "kind": "note"})
    assert proc.can_handle(note_job) is False


# ---- process ---------------------------------------------------------------


def test_process_with_no_extractors_returns_zero_chunks(
    store, tmp_path: Path
):
    """No OCR + no captioner = nothing to index, but the job still
    completes cleanly (records as indexed with 0 chunks)."""
    proc = ImageProcessor(store, StubEmbedder())
    img = tmp_path / "x.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    written = proc.process(_make_job(img))
    assert written == 0
    assert store.count() == 0


def test_process_indexes_ocr_text_when_extractor_provided(
    store, tmp_path: Path
):
    captured: list[Path] = []

    def fake_ocr(path: Path) -> str:
        captured.append(path)
        return "OAuth 2.1 introduces PKCE for every public client."

    proc = ImageProcessor(store, StubEmbedder(), ocr_extract=fake_ocr)
    img = tmp_path / "screenshot.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))

    assert written >= 1
    assert captured == [img]
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "OCR:" in joined
    assert "PKCE" in joined


def test_process_indexes_caption_when_extractor_provided(
    store, tmp_path: Path
):
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        caption_extract=lambda _p: "A diagram of three boxes labelled A, B, C.",
    )
    img = tmp_path / "diagram.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))
    assert written >= 1
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "Caption:" in joined
    assert "diagram" in joined.lower()


def test_process_concatenates_ocr_and_caption_when_both_succeed(
    store, tmp_path: Path
):
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "Token rotation flow",
        caption_extract=lambda _p: "Whiteboard photo with arrows",
    )
    img = tmp_path / "x.jpg"
    img.write_bytes(b"")
    proc.process(_make_job(img))
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "OCR:" in joined and "Caption:" in joined
    assert "rotation" in joined and "Whiteboard" in joined


def test_process_continues_when_ocr_extractor_raises(store, tmp_path: Path):
    """One extractor's failure doesn't block the other from contributing."""

    def boom(_p: Path) -> str:
        raise RuntimeError("paddleocr crashed")

    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=boom,
        caption_extract=lambda _p: "Whiteboard photo",
    )
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))
    assert written >= 1
    joined = "\n".join(r["text"] for r in store.scan(UUID_A))
    assert "OCR:" not in joined
    assert "Whiteboard" in joined


def test_process_returns_zero_when_all_extractors_yield_empty(
    store, tmp_path: Path
):
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "",
        caption_extract=lambda _p: "   ",
    )
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    assert proc.process(_make_job(img)) == 0
    assert store.count() == 0


def test_process_replaces_previous_chunks_on_re_index(store, tmp_path: Path):
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "First version of the OCR text",
    )
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    proc.process(_make_job(img))
    initial_count = store.count()
    assert initial_count >= 1

    proc_v2 = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "Second version with totally different text",
    )
    proc_v2.process(_make_job(img))
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "First version" not in joined
    assert "Second version" in joined


def test_process_raises_on_missing_file(store, tmp_path: Path):
    proc = ImageProcessor(store, StubEmbedder())
    with pytest.raises(FileNotFoundError):
        proc.process(_make_job(tmp_path / "nonexistent.png"))


# ---- dispatcher integration ------------------------------------------------


def test_dispatcher_routes_image_jobs_to_image_processor(
    store, tmp_path: Path
):
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    found = dispatcher.find(_make_job(img))
    assert isinstance(found, ImageProcessor)


def test_dispatcher_does_not_route_pdfs_to_image_processor(
    store, tmp_path: Path
):
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"")
    found = dispatcher.find(_make_job(pdf))
    assert not isinstance(found, ImageProcessor)
