"""PDF processor — extracts text via PyMuPDF, chunks, embeds, upserts.

Test PDFs are synthesised in-process via PyMuPDF so the suite stays
hermetic and doesn't depend on a fixture binary file in the repo.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pymupdf
import pytest

from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.pdf import PdfProcessor
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.storage import open_store, role_or_default

UUID_A = "11111111-1111-1111-1111-111111111111"


def _make_pdf(path: Path, pages: list[str]) -> None:
    """Write a multi-page PDF whose pages contain the supplied
    strings. PyMuPDF's ``insert_text`` is enough to give us a text
    layer the processor can extract."""
    doc = pymupdf.open()
    for body in pages:
        page = doc.new_page()
        page.insert_text((72, 72), body)
    doc.save(str(path))
    doc.close()


def _make_encrypted_pdf(path: Path, body: str, password: str) -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), body)
    doc.save(
        str(path),
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        owner_pw=password,
        user_pw=password,
    )
    doc.close()


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
def proc(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    return PdfProcessor(store, StubEmbedder()), store


# ---- can_handle ------------------------------------------------------------


def test_can_handle_only_pdf_extension(tmp_path: Path):
    proc = PdfProcessor(open_store(tmp_path / "i.lance"), StubEmbedder())
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"")
    md = tmp_path / "x.md"
    md.write_bytes(b"")
    assert proc.can_handle(_make_job(pdf)) is True
    assert proc.can_handle(_make_job(md)) is False


def test_can_handle_rejects_note_kind(tmp_path: Path):
    proc = PdfProcessor(open_store(tmp_path / "i.lance"), StubEmbedder())
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"")
    job = _make_job(pdf)
    note_job = IndexingJob(**{**job.__dict__, "kind": "note"})
    assert proc.can_handle(note_job) is False


# ---- process ---------------------------------------------------------------


def test_process_extracts_text_and_writes_chunks(tmp_path: Path, proc):
    processor, store = proc
    pdf = tmp_path / "doc.pdf"
    _make_pdf(
        pdf,
        [
            "OAuth 2.1 introduces PKCE for every public client.",
            "Refresh tokens should rotate on each use.",
        ],
    )
    written = processor.process(_make_job(pdf))
    assert written >= 1
    assert store.count() == written
    # Round-trip: at least one chunk contains text from page 1.
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "PKCE" in joined
    assert "Refresh" in joined
    assert {role_or_default(r) for r in rows} == {"body"}


def test_process_replaces_previous_chunks_on_re_index(tmp_path: Path, proc):
    processor, store = proc
    pdf = tmp_path / "doc.pdf"
    _make_pdf(pdf, ["First version of the document."])
    processor.process(_make_job(pdf))
    initial = store.count()

    _make_pdf(pdf, ["Second version with totally different text."])
    processor.process(_make_job(pdf))
    # Old chunks gone; new chunks present.
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "First version" not in joined
    assert "Second version" in joined
    # Count is bounded by the new content, not cumulative.
    assert store.count() <= max(initial, len(rows))


def test_process_handles_image_only_pdf_with_zero_chunks(tmp_path: Path, proc):
    """A PDF with no text layer (a scanned image, or in this test
    just an empty page) returns 0 chunks rather than raising. OCR
    extraction is the image processor's job, not this one."""
    processor, store = proc
    pdf = tmp_path / "blank.pdf"
    doc = pymupdf.open()
    doc.new_page()  # page with no inserted text
    doc.save(str(pdf))
    doc.close()

    written = processor.process(_make_job(pdf))
    assert written == 0
    assert store.count() == 0


def test_process_raises_on_encrypted_pdf(tmp_path: Path, proc):
    processor, _ = proc
    pdf = tmp_path / "secret.pdf"
    _make_encrypted_pdf(pdf, "secret content", password="hunter2")
    with pytest.raises(RuntimeError, match="encrypted"):
        processor.process(_make_job(pdf))


def test_process_raises_on_corrupt_pdf(tmp_path: Path, proc):
    processor, _ = proc
    pdf = tmp_path / "bogus.pdf"
    pdf.write_bytes(b"this is not a pdf file at all")
    with pytest.raises(RuntimeError, match="corrupt"):
        processor.process(_make_job(pdf))


def test_process_raises_on_missing_file(tmp_path: Path, proc):
    processor, _ = proc
    with pytest.raises(FileNotFoundError):
        processor.process(_make_job(tmp_path / "nonexistent.pdf"))


def test_process_truncates_at_max_pages(tmp_path: Path):
    """``max_pages`` caps how much text we extract. Pages beyond
    the cap are silently dropped from the index."""
    store = open_store(tmp_path / "index.lance")
    processor = PdfProcessor(store, StubEmbedder(), max_pages=2)
    pdf = tmp_path / "long.pdf"
    _make_pdf(
        pdf,
        [
            "First page mentions PKCE for sure.",
            "Second page also has content.",
            "Third page has SHIBBOLETH which is unique.",
        ],
    )
    processor.process(_make_job(pdf))
    rows = store.scan(UUID_A)
    joined = "\n".join(r["text"] for r in rows)
    assert "PKCE" in joined
    assert "SHIBBOLETH" not in joined


# ---- dispatcher integration ------------------------------------------------


def test_dispatcher_routes_pdf_jobs_to_pdf_processor(tmp_path: Path):
    """The dispatcher exposes the new processor — a kind=file job
    with a .pdf suffix lands on it, not on the text or url_cache
    processors."""
    from search_sidecar.index.dispatch import Dispatcher

    store = open_store(tmp_path / "index.lance")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"")
    found = dispatcher.find(_make_job(pdf))
    assert isinstance(found, PdfProcessor)
