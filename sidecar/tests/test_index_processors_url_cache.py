"""URL-cache processor: HTML strip + chunk + embed + upsert."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.url_cache import (
    URLCacheProcessor,
    extract_readable_text,
)
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.storage import open_store


def _make_job(
    path: Path,
    *,
    kind: str = "url",
    node_id: str = "11111111-1111-1111-1111-111111111111",
) -> IndexingJob:
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


# ----- extract_readable_text ----------------------------------------------


def test_extract_drops_script_and_style():
    html = b"""
    <html>
      <head>
        <title>Example</title>
        <style>body { color: red; }</style>
      </head>
      <body>
        <script>alert('xss');</script>
        <p>Visible paragraph.</p>
        <p>Another paragraph.</p>
      </body>
    </html>
    """
    text = extract_readable_text(html)
    assert "Visible paragraph." in text
    assert "Another paragraph." in text
    assert "color: red" not in text
    assert "alert" not in text


def test_extract_handles_missing_body():
    html = b"<html><div>Just a div.</div></html>"
    text = extract_readable_text(html)
    assert "Just a div." in text


def test_extract_handles_empty_input():
    assert extract_readable_text(b"") == ""
    assert extract_readable_text(b"<html></html>") == ""


def test_extract_handles_malformed_html_without_raising():
    # Unclosed tags, dangling angle bracket — must not raise
    html = b"<html><body><p>broken <span>nested without close"
    text = extract_readable_text(html)
    assert "broken" in text


def test_extract_collapses_runs_of_blank_lines():
    html = b"<html><body><p>A</p><p>B</p><p>C</p></body></html>"
    text = extract_readable_text(html)
    assert "\n\n\n" not in text
    assert text.count("A") == 1
    assert text.count("B") == 1


def test_extract_strips_iframe_and_svg():
    html = b"""
    <html>
      <body>
        <iframe src='ad.html'>fallback</iframe>
        <svg><defs>noise</defs></svg>
        <p>Real content.</p>
      </body>
    </html>
    """
    text = extract_readable_text(html)
    assert "Real content." in text
    assert "noise" not in text
    assert "fallback" not in text


def test_extract_accepts_string_input():
    text = extract_readable_text("<html><body><p>hi</p></body></html>")
    assert "hi" in text


# ----- URLCacheProcessor --------------------------------------------------


def test_can_handle_url_kind_with_html_extension(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "abc.html"
    cache.write_bytes(b"<p>hi</p>")
    assert proc.can_handle(_make_job(cache))


def test_can_handle_rejects_note_kind(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "abc.html"
    cache.write_bytes(b"<p>hi</p>")
    assert not proc.can_handle(_make_job(cache, kind="note"))


def test_can_handle_extensionless_url_cache(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "abc"  # no extension
    cache.write_bytes(b"<p>hi</p>")
    assert proc.can_handle(_make_job(cache))


def test_can_handle_rejects_pdf_extension(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "abc.pdf"
    cache.write_bytes(b"%PDF-1.4")
    assert not proc.can_handle(_make_job(cache))


def test_process_writes_chunks_from_html_body(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "page.html"
    cache.write_bytes(
        b"""
        <html>
          <head><title>Doc</title><style>body{}</style></head>
          <body>
            <h1>Title</h1>
            <p>First paragraph for indexing.</p>
            <p>Second paragraph here.</p>
            <script>tracker();</script>
          </body>
        </html>
        """
    )
    written = proc.process(_make_job(cache))
    assert written >= 1
    assert store.count() == written
    # Persisted text must not contain stripped content
    rows = store.scan("11111111-1111-1111-1111-111111111111")
    joined = " ".join(r["text"] for r in rows)
    assert "First paragraph" in joined
    assert "tracker" not in joined
    assert "body{}" not in joined


def test_process_replaces_previous_chunks_on_re_index(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "page.html"
    job = _make_job(cache)

    cache.write_bytes(b"<html><body><p>Original page.</p></body></html>")
    proc.process(job)
    first_count = store.count()
    assert first_count == 1

    cache.write_bytes(
        b"<html><body><p>New first.</p><p>And second.</p></body></html>"
    )
    proc.process(job)
    # Old chunk replaced by two new ones
    assert store.count() == 2


def test_process_handles_empty_body(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "empty.html"
    cache.write_bytes(b"<html><body></body></html>")
    written = proc.process(_make_job(cache))
    assert written == 0
    assert store.count() == 0


def test_process_raises_on_missing_file(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    job = _make_job(tmp_path / "absent.html")
    with pytest.raises(FileNotFoundError, match="url cache file"):
        proc.process(job)


def test_process_does_not_raise_on_malformed_html(tmp_path: Path):
    """Malformed HTML must not poison the queue — selectolax's parser
    is lenient; the processor should treat broken markup as a normal
    indexing event."""
    store = open_store(tmp_path / "index.lance")
    proc = URLCacheProcessor(store, StubEmbedder())
    cache = tmp_path / "broken.html"
    cache.write_bytes(b"<html><body><p>broken <span>but readable")
    written = proc.process(_make_job(cache))
    assert written >= 1
    assert store.count() == written
