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

import httpx
import pytest

from search_sidecar.extract.types import ExtractedMarkdown
from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.extract_artifacts import write_extract_artifact
from search_sidecar.index.job import IndexingJob, JobState
from search_sidecar.index.processors.image import ImageProcessor
from search_sidecar.storage import open_store, role_or_default

UUID_A = "11111111-1111-1111-1111-111111111111"


class DummyImage:
    def save(self, path: Path, *, format: str | None = None) -> None:
        path.write_bytes(b"dummy image")


class FailingEmbedder:
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise RuntimeError("embedding failed")


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


def _enhancement_claim(job: IndexingJob) -> tuple[IndexingJob, int]:
    return job, 0


def _http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://example.test/v1")
    response = httpx.Response(status, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


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


def test_process_indexes_ocr_text_as_body_chunks(store, tmp_path: Path):
    captured: list[Path] = []

    def fake_ocr(path: Path) -> str:
        captured.append(path)
        return "OAuth 2.1 introduces PKCE for every public client."

    proc = ImageProcessor(store, StubEmbedder(), ocr_extract=fake_ocr)
    img = tmp_path / "screenshot.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))

    # Single short sentence fits in one chunk under MAX_CHUNK_CHARS.
    assert written == 1
    assert captured == [img]
    rows = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows} == {"body"}
    joined = " ".join(r["text"] for r in rows)
    assert "PKCE" in joined
    # No literal "OCR:" prefix bled into the indexed text.
    assert "OCR:" not in joined
    # All body row ids are <node>:<int>, no ":summary:" segment.
    for row in rows:
        assert ":summary:" not in row["id"]


def test_process_indexes_caption_as_summary_chunks(store, tmp_path: Path):
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        caption_extract=lambda _p: "A diagram of three boxes labelled A, B, C.",
    )
    img = tmp_path / "diagram.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))
    assert written == 1
    rows = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows} == {"summary"}
    summary_ids = sorted(r["id"] for r in rows)
    assert summary_ids == [f"{UUID_A}:summary:0"]
    joined = " ".join(r["text"] for r in rows)
    assert "diagram" in joined.lower()
    assert "Caption:" not in joined


def test_process_emits_body_and_summary_when_both_extractors_succeed(
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
    by_role: dict[str, list[dict]] = {"body": [], "summary": []}
    for row in rows:
        by_role[role_or_default(row)].append(row)
    body_text = " ".join(r["text"] for r in by_role["body"])
    summary_text = " ".join(r["text"] for r in by_role["summary"])
    assert "rotation" in body_text and "OCR:" not in body_text
    assert "Whiteboard" in summary_text and "Caption:" not in summary_text


def test_process_writes_basic_and_caption_extract_artifacts(
    store, tmp_path: Path
):
    extract_dir = tmp_path / "extract"
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "Basic OCR markdown",
        caption_extract=lambda _p: "Caption markdown",
        extract_dir=extract_dir,
    )
    img = tmp_path / "image a.png"
    img.write_bytes(b"")

    proc.process(_make_job(img))

    image_dir = extract_dir / UUID_A
    assert (image_dir / "basic.md").read_text() == "Basic OCR markdown\n"
    assert (image_dir / "caption.md").read_text() == "Caption markdown\n"


def test_process_clears_stale_extract_artifacts_before_basic_pass(
    store, tmp_path: Path
):
    extract_dir = tmp_path / "extract"
    write_extract_artifact(extract_dir, UUID_A, "advanced", "old advanced")
    write_extract_artifact(extract_dir, UUID_A, "caption", "old caption")
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "new basic",
        caption_extract=None,
        extract_dir=extract_dir,
    )
    img = tmp_path / "image.png"
    img.write_bytes(b"")

    proc.process(_make_job(img))

    image_dir = extract_dir / UUID_A
    assert (image_dir / "basic.md").read_text() == "new basic\n"
    assert not (image_dir / "advanced.md").exists()
    assert not (image_dir / "caption.md").exists()


def test_process_keeps_previous_chunks_and_artifacts_when_embedding_fails(
    store, tmp_path: Path
):
    extract_dir = tmp_path / "extract"
    img = tmp_path / "image.png"
    img.write_bytes(b"")
    job = _make_job(img)
    ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "old OCR",
        caption_extract=lambda _p: "old caption",
        extract_dir=extract_dir,
    ).process(job)

    with pytest.raises(RuntimeError, match="embedding failed"):
        ImageProcessor(
            store,
            FailingEmbedder(),
            ocr_extract=lambda _p: "new OCR",
            caption_extract=lambda _p: "new caption",
            extract_dir=extract_dir,
        ).process(job)

    rows = store.scan(UUID_A)
    assert "old OCR" in "\n".join(r["text"] for r in rows)
    assert "old caption" in "\n".join(r["text"] for r in rows)
    assert (extract_dir / UUID_A / "basic.md").read_text() == "old OCR\n"
    assert (extract_dir / UUID_A / "caption.md").read_text() == "old caption\n"


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
    assert written == 1
    rows = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows} == {"summary"}
    joined = " ".join(r["text"] for r in rows)
    assert "Whiteboard" in joined


def test_process_continues_when_caption_extractor_raises(
    store, tmp_path: Path
):
    """Symmetric to OCR-raises: a failing captioner doesn't block OCR."""

    def boom(_p: Path) -> str:
        raise RuntimeError("llama-server crashed")

    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "Token rotation flow",
        caption_extract=boom,
    )
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    written = proc.process(_make_job(img))
    assert written == 1
    rows = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows} == {"body"}
    joined = " ".join(r["text"] for r in rows)
    assert "Token rotation" in joined


def test_re_index_without_caption_removes_orphaned_summary_rows(
    store, tmp_path: Path
):
    """First index produces body+summary; second index (OCR-only) must
    leave zero summary rows. This verifies the delete-then-upsert
    atomicity claim across roles, not just within body chunks."""
    img = tmp_path / "x.png"
    img.write_bytes(b"")

    proc_v1 = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "First OCR text",
        caption_extract=lambda _p: "First caption text",
    )
    proc_v1.process(_make_job(img))
    rows_v1 = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows_v1} == {"body", "summary"}

    proc_v2 = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "Second OCR text",
        # caption_extract intentionally None — captioner unwired now.
    )
    proc_v2.process(_make_job(img))
    rows_v2 = store.scan(UUID_A)
    assert {role_or_default(r) for r in rows_v2} == {"body"}, (
        "summary rows from v1 must be cleaned up by v2's "
        "delete_by_node_id, not orphaned"
    )
    joined = " ".join(r["text"] for r in rows_v2)
    assert "First" not in joined
    assert "Second OCR text" in joined


def test_process_chunks_long_caption_into_multiple_summary_rows(
    store, tmp_path: Path
):
    """A future-D6-style long summary splits via the same chunker as
    body text — proves the schema absorbs longer summaries without
    further work. 800-char paragraph splits to 2 rows under the
    512-char chunker cap."""
    long_caption = "lorem ipsum dolor sit amet " * 40  # ~ 1080 chars
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        caption_extract=lambda _p: long_caption,
    )
    img = tmp_path / "long.png"
    img.write_bytes(b"")
    proc.process(_make_job(img))
    rows = store.scan(UUID_A)
    summary_rows = [r for r in rows if role_or_default(r) == "summary"]
    assert len(summary_rows) >= 2
    # Every summary row id follows the <node>:summary:<int> convention.
    for row in summary_rows:
        prefix, _, idx = row["id"].rpartition(":")
        assert prefix.endswith(":summary")
        assert idx.isdigit()


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


def test_basic_pass_does_not_flag_enhancement_queue(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic text",
        advanced_ocr_extract=lambda _p: "advanced text",
    )
    assert proc.process(_make_job(img)) == 1


def test_basic_pass_does_not_flag_empty_body_or_missing_advanced(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "",
        advanced_ocr_extract=lambda _p: "advanced text",
    )
    assert proc.process(_make_job(img)) == 0

    proc2 = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic text",
    )
    assert proc2.process(_make_job(img, node_id=UUID_A.replace("1", "2", 1))) == 1


def test_process_enhancement_replaces_body_and_preserves_summary(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    job = _make_job(img)
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic OCR text",
        caption_extract=lambda _p: "A caption that should survive.",
        advanced_ocr_extract=lambda _p: "advanced table text",
    )
    proc.process(job)
    proc.process_enhancement(*_enhancement_claim(job))

    rows = store.scan(UUID_A)
    body = [r for r in rows if role_or_default(r) == "body"]
    summary = [r for r in rows if role_or_default(r) == "summary"]
    assert len(body) == 1
    assert "advanced table text" in body[0]["text"]
    assert len(summary) == 1
    assert "caption" in summary[0]["text"]


def test_process_enhancement_writes_advanced_extract_artifact(
    store, tmp_path: Path
):
    extract_dir = tmp_path / "extract"
    img = tmp_path / "a.png"
    img.write_bytes(b"")
    job = _make_job(img)
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic OCR text",
        advanced_ocr_extract=lambda _p: "advanced table markdown",
        extract_dir=extract_dir,
    )
    proc.process(job)
    proc.process_enhancement(*_enhancement_claim(job))

    assert (extract_dir / UUID_A / "advanced.md").read_text() == (
        "advanced table markdown\n"
    )


def test_process_enhancement_writes_advanced_extract_assets(
    store, tmp_path: Path
):
    extract_dir = tmp_path / "extract"
    img = tmp_path / "a.png"
    img.write_bytes(b"")
    job = _make_job(img)
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic OCR text",
        advanced_ocr_extract=lambda _p: ExtractedMarkdown(
            '<img src="imgs/crop.jpg" alt="crop" />\n\ninvoice text',
            {"imgs/crop.jpg": DummyImage()},
        ),
        extract_dir=extract_dir,
    )
    proc.process(job)
    proc.process_enhancement(*_enhancement_claim(job))

    image_dir = extract_dir / UUID_A
    assert (image_dir / "advanced.md").read_text() == (
        '<img src="imgs/crop.jpg" alt="crop" />\n\ninvoice text\n'
    )
    asset_path = image_dir / "assets" / "advanced" / "imgs" / "crop.png"
    assert asset_path.read_bytes() == b"dummy image"
    body = [r for r in store.scan(UUID_A) if role_or_default(r) == "body"]
    assert len(body) == 1
    assert "invoice text" in body[0]["text"]
    assert "<img" not in body[0]["text"]


def test_process_enhancement_empty_after_chunking_keeps_basic(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    job = _make_job(img)
    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: "basic OCR text",
        advanced_ocr_extract=lambda _p: "-",
    )
    proc.process(job)
    proc.process_enhancement(*_enhancement_claim(job))

    rows = store.scan(UUID_A)
    assert "basic OCR text" in " ".join(r["text"] for r in rows)


def test_process_enhancement_transient_error_bubbles_to_caller(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    job = _make_job(img)

    def raise_429(_p: Path) -> str:
        raise _http_error(429)

    proc = ImageProcessor(
        store,
        StubEmbedder(),
        advanced_ocr_extract=raise_429,
    )
    with pytest.raises(httpx.HTTPStatusError):
        proc.process_enhancement(*_enhancement_claim(job))


def test_process_enhancement_terminal_error_bubbles_to_caller(
    store, tmp_path: Path
):
    img = tmp_path / "x.png"
    img.write_bytes(b"")
    job = _make_job(img)

    proc = ImageProcessor(
        store,
        StubEmbedder(),
        advanced_ocr_extract=lambda _p: (_ for _ in ()).throw(_http_error(401)),
    )
    with pytest.raises(httpx.HTTPStatusError):
        proc.process_enhancement(*_enhancement_claim(job))


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


# ---- cross-layer regression -----------------------------------------------


def test_image_processor_writes_flow_through_content_endpoint(
    store, tmp_path: Path
):
    """End-to-end: ImageProcessor writes → /index/node/{id}/content
    serves the rows in the documented body-then-summary order with
    role tags carrying through; no ``OCR:``/``Caption:`` prefix
    leaks anywhere along the chain."""
    from fastapi.testclient import TestClient

    from search_sidecar.app import build_app

    proc = ImageProcessor(
        store,
        StubEmbedder(),
        ocr_extract=lambda _p: (
            "PKCE 1.0 specifies refresh tokens "
            "should rotate on every grant exchange."
        ),
        caption_extract=lambda _p: "A cropped screenshot of the spec.",
    )
    img = tmp_path / "spec.png"
    img.write_bytes(b"")
    proc.process(_make_job(img))

    token = "0123456789abcdef" * 4
    app = build_app(token=token, lancedb_store=store)
    with TestClient(app) as client:
        resp = client.get(
            f"/index/node/{UUID_A}/content",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["node_id"] == UUID_A
    assert body["kind"] == "file"

    # Every chunk has a role; body chunks come before summary chunks.
    roles = [c["role"] for c in body["chunks"]]
    assert roles, "expected at least one chunk"
    first_summary = next(
        (i for i, r in enumerate(roles) if r == "summary"), len(roles)
    )
    assert all(r == "body" for r in roles[:first_summary])
    assert all(r == "summary" for r in roles[first_summary:])

    # Joined string preserves the same body-then-summary ordering and
    # contains no prefix leakage.
    joined = body["joined"]
    assert "PKCE" in joined
    assert "cropped screenshot" in joined
    assert "OCR:" not in joined
    assert "Caption:" not in joined
    pos_body = joined.find("PKCE")
    pos_summary = joined.find("cropped screenshot")
    assert pos_body < pos_summary


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
