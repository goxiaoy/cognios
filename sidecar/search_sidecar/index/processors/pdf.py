"""PDF processor.

Opens the PDF at ``IndexingJob.absolute_content_path`` with PyMuPDF,
concatenates the extracted text from each page, splits the result
into bounded chunks via :mod:`..chunking`, embeds each chunk, and
upserts the resulting :class:`NodeChunk`s into the lancedb store.

Design notes:

- **Page cap.** ``MAX_PAGES`` bounds the per-document extraction so
  a 5000-page PDF can't park a worker for minutes. Anything beyond
  the cap is silently truncated; the user-visible signal is that
  later content is missing from search. The plan's per-job timeout
  (Unit 5 part 2) is the longer-term answer; the cap is the quick
  defence today.
- **Encrypted PDFs.** PyMuPDF marks the document as ``needs_pass``
  and refuses to extract until ``authenticate()`` succeeds. v1
  treats encrypted PDFs as un-indexable (raises so the runner
  surfaces the error per-job). Password storage is out of scope.
- **Text-only.** OCR-style extraction from image-based PDFs is the
  Unit 5.4 image processor's job; this processor only reads the
  text layer. Image-only PDFs return an empty string and are
  recorded as "0 chunks indexed" rather than an error.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pymupdf  # type: ignore[import-untyped]

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..queue import IndexingJob

# Hard cap on pages we extract. PyMuPDF is fast (~5 ms/page on a
# typical text PDF) so 500 pages is a few seconds — well within the
# per-job budget once timeouts ship. Beyond this we silently truncate
# rather than blocking the runner indefinitely.
MAX_PAGES = 500


class PdfProcessor:
    """Processes ``kind="file"`` nodes whose suffix is ``.pdf``.

    The runner instantiates one of these per worker thread. The
    embedder is injected so tests can pass :class:`StubEmbedder` and
    production gets the factory-selected one.
    """

    KINDS = ("file",)
    EXTENSIONS = (".pdf",)

    def __init__(
        self,
        store: LanceDBStore,
        embedder: Embedder,
        *,
        max_pages: int = MAX_PAGES,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._max_pages = max_pages

    def can_handle(self, job: IndexingJob) -> bool:
        if job.kind not in self.KINDS:
            return False
        if job.absolute_content_path is None:
            return False
        suffix = Path(job.absolute_content_path).suffix.lower()
        return suffix in self.EXTENSIONS

    def process(self, job: IndexingJob) -> int:
        """Open, extract, chunk, embed, upsert. Returns chunk count."""
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing pdf: {path}")
        text = self._extract_text(path)
        chunks = chunk_text(text)

        # Always replace the node's previous chunks — same contract
        # TextProcessor uses for re-index.
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
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        self._store.upsert(rows)
        return len(rows)

    def _extract_text(self, path: Path) -> str:
        """Concatenate text from every page (capped at ``max_pages``).

        Encrypted PDFs raise; image-only PDFs return ``""``.
        """
        try:
            doc = pymupdf.open(path)
        except pymupdf.FileDataError as cause:
            raise RuntimeError(f"corrupt PDF: {path.name}") from cause
        try:
            if doc.needs_pass:
                raise RuntimeError(
                    f"encrypted PDF (password required): {path.name}"
                )
            pages: list[str] = []
            for idx, page in enumerate(doc):
                if idx >= self._max_pages:
                    break
                pages.append(page.get_text("text") or "")
            return "\n\n".join(p.strip() for p in pages if p and p.strip())
        finally:
            doc.close()
