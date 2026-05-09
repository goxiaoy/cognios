"""URL-cache processor.

Reads the raw HTML file Rust caches under ``~/.cogios/url-cache/``,
extracts readable body text via :mod:`selectolax`, splits the result
into chunks via the shared :mod:`..chunking` helper, embeds each chunk,
and upserts into the lancedb store.

Why we do the strip on the Python side rather than reading
``url_jobs.preview_text`` from cognios.db: the preview is hard-truncated
at 320 chars by the existing Rust pipeline (see
``src-tauri/src/services/url_indexing/cache.rs``), which is the right
shape for the Explorer inspector but far too short for full-text
indexing. The cache file is the authoritative source of the raw
content; selectolax + a small tag deny-list gets us a clean readable
body in the same call.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from selectolax.parser import HTMLParser

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..queue import IndexingJob

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
        readable = extract_readable_text(raw)
        chunks = chunk_text(readable)

        # Always replace the previous chunks for this node — the
        # simplest way to keep the index consistent on re-fetch.
        self._store.delete_by_node_id(job.node_id)
        if not chunks:
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
        self._store.upsert(rows)
        return len(rows)


def extract_readable_text(html: bytes | str) -> str:
    """Strip ``html`` to readable plain text.

    selectolax is fail-soft against malformed input — it will return
    something usable for content like ``<html><body><p>broken``. The
    function never raises on bad markup.
    """
    if not html:
        return ""
    if isinstance(html, bytes):
        # selectolax handles bytes directly, but decoding early lets us
        # bail early on empty-after-decode inputs.
        try:
            html = html.decode("utf-8", errors="replace")
        except UnicodeDecodeError:
            html = html.decode("latin-1", errors="replace")
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
