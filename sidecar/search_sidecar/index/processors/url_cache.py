"""URL-cache processor.

Reads the raw HTML file Rust caches under ``~/.cogios/url-cache/``,
extracts readable article Markdown via :mod:`trafilatura`, splits the
result into chunks via the shared :mod:`..chunking` helper, embeds each
chunk, and upserts into the lancedb store.

Why we do the strip on the Python side rather than reading
``urls.preview_text`` from cognios.db: the preview is hard-truncated
at 320 chars by the existing Rust pipeline (see
``src-tauri/src/services/url_indexing/cache.rs``), which is the right
shape for the Explorer inspector but far too short for full-text
indexing. The cache file is the authoritative source of the raw
content; Trafilatura gets us a markdown-shaped article body, with
selectolax as the fail-soft fallback for malformed or low-signal pages.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from selectolax.parser import HTMLParser
from trafilatura import extract as trafilatura_extract

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..job import IndexingJob

# Tags whose content should never be indexed even when present in
# ``<body>`` — scripts, styles, navigation chrome, social embeds, ads.
DROP_SELECTORS = (
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
)

# Cache file extensions we recognise. Empty string covers the existing
# Rust pattern of ``<cache_dir>/<node_id>`` (no extension).
_HTML_EXTENSIONS = (".html", ".htm", "")

_BLANK_LINE_RUN = re.compile(r"\n{3,}")


class URLCacheProcessor:
    """Processes ``kind="url"`` nodes whose ``absolute_content_path``
    points at a cached HTML body."""

    KINDS = ("url",)

    def __init__(self, store: LanceDBStore, embedder: Embedder) -> None:
        self._store = store
        self._embedder = embedder

    def can_handle(self, job: IndexingJob) -> bool:
        if job.kind not in self.KINDS:
            return False
        if job.absolute_content_path is None:
            return False
        suffix = Path(job.absolute_content_path).suffix.lower()
        return suffix in _HTML_EXTENSIONS

    def process(self, job: IndexingJob) -> int:
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"url cache file missing: {path}")

        raw = path.read_bytes()
        markdown = extract_markdown(raw)
        chunks = chunk_text(markdown)

        if not chunks:
            self._store.replace_node_chunks(job.node_id, [])
            return 0

        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )

        now = datetime.now(timezone.utc)
        rows = [
            NodeChunk(
                id=f"{job.node_id}:{i}",
                node_id=job.node_id,
                kind=job.kind,
                name=job.name,
                text=chunk,
                vector=vec,
                mount_id=job.mount_id,
                created_at=job.created_at,
                modified_at=job.modified_at or now,
                role="body",
                content_version=job.content_version,
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        return self._store.replace_node_chunks(job.node_id, rows)


def extract_markdown(html: bytes | str) -> str:
    """Extract readable Markdown from cached URL ``html``.

    Trafilatura handles the main article extraction and converts
    headings, lists, links, and tables into Markdown. It returns
    ``None`` for sparse pages, so we keep the old selectolax path as a
    fallback to avoid dropping indexable text from simple fragments.
    """
    text = _decode_html(html)
    if not text.strip():
        return ""

    markdown = trafilatura_extract(
        text,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        include_formatting=True,
        deduplicate=True,
        favor_recall=True,
    )
    if markdown and markdown.strip():
        return _BLANK_LINE_RUN.sub("\n\n", markdown).strip()
    return extract_readable_text(text)


def extract_readable_text(html: bytes | str) -> str:
    """Strip ``html`` to readable plain text.

    selectolax is fail-soft against malformed input — it will return
    something usable for content like ``<html><body><p>broken``. The
    function never raises on bad markup.
    """
    html = _decode_html(html)
    if not html.strip():
        return ""

    tree = HTMLParser(html)
    for selector in DROP_SELECTORS:
        for node in tree.css(selector):
            node.decompose()

    # Prefer the body's visible text; fall back to whole-tree text if
    # the body element is absent (some fragmentary cache files).
    # ``separator="\n\n"`` lifts HTML block boundaries (<p>, <div>, <h1>)
    # into the chunker's paragraph-separator vocabulary so the same
    # downstream chunker handles HTML and Markdown the same way.
    body = tree.body
    text = (
        body.text(separator="\n\n") if body is not None else tree.text(separator="\n\n")
    )
    if text is None:
        return ""

    # Collapse pathological blank-line runs that selectolax sometimes
    # emits between empty inline boundaries.
    cleaned = _BLANK_LINE_RUN.sub("\n\n", text).strip()
    return cleaned


def _decode_html(html: bytes | str) -> str:
    if not html:
        return ""
    if isinstance(html, str):
        return html
    # Decode early so both Trafilatura and selectolax see the same
    # text input and sparse/empty inputs can bail out cheaply.
    try:
        return html.decode("utf-8", errors="replace")
    except UnicodeDecodeError:
        return html.decode("latin-1", errors="replace")
