"""PDF processor.

Opens the PDF at ``IndexingJob.absolute_content_path`` with PyMuPDF,
concatenates the extracted text from each page, splits the result
into bounded chunks via :mod:`..chunking`, embeds each chunk, and
stores the resulting :class:`NodeChunk`s into the lancedb store.

PDF indexing mirrors the image flow:

1. A fast first pass reads the embedded text layer via PyMuPDF.
2. When local PP-StructureV3 is available, a slower background
   enhancement re-runs layout-aware OCR and replaces only body chunks.

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
- **Scanned PDFs.** If the text layer is empty and enhancement is
  available, the processor leaves any previous body chunks in place
  until the OCR pass completes. If enhancement is unavailable, empty
  text is recorded as "0 chunks indexed" rather than an error.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

import pymupdf  # type: ignore[import-untyped]

from ...storage import LanceDBStore, NodeChunk, role_or_default
from ..chunking import chunk_text
from ..embedder import Embedder
from ..extract_artifacts import (
    ArtifactKind,
    clear_extract_artifacts,
    write_extract_artifact,
)
from ..queue import IndexingJob, IndexingQueue
from .enhancement import (
    AdvancedOcrExtract,
    ExtractAssets,
    extract_text_and_assets,
    handle_enhancement_error,
    meaningful_chunks,
    strip_image_references,
)

LOG = logging.getLogger("search_sidecar.index.processors.pdf")

# Hard cap on pages we extract. PyMuPDF is fast (~5 ms/page on a
# typical text PDF) so 500 pages is a few seconds — well within the
# per-job budget once timeouts ship. Beyond this we silently truncate
# rather than blocking the runner indefinitely.
MAX_PAGES = 500
SUPPORTED_EXTENSIONS = (".pdf",)


class PdfProcessor:
    """Processes ``kind="file"`` nodes whose suffix is ``.pdf``.

    The runner instantiates one of these per worker thread. The
    embedder is injected so tests can pass :class:`StubEmbedder` and
    production gets the factory-selected one.
    """

    KINDS = ("file",)
    EXTENSIONS = SUPPORTED_EXTENSIONS

    def __init__(
        self,
        store: LanceDBStore,
        embedder: Embedder,
        *,
        max_pages: int = MAX_PAGES,
        queue: IndexingQueue | None = None,
        advanced_ocr_extract: AdvancedOcrExtract | None = None,
        extract_dir: Path | None = None,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._max_pages = max_pages
        self._queue = queue
        self._advanced_ocr_extract = advanced_ocr_extract
        self._extract_dir = extract_dir

    def can_handle(self, job: IndexingJob) -> bool:
        if job.kind not in self.KINDS:
            return False
        if job.absolute_content_path is None:
            return False
        suffix = Path(job.absolute_content_path).suffix.lower()
        return suffix in self.EXTENSIONS

    def process(self, job: IndexingJob) -> int:
        """Run the fast text-layer pass. Returns chunk count."""
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing pdf: {path}")
        text = self._extract_text(path)
        chunks = chunk_text(text)

        if not chunks:
            if self.has_advanced_ocr() and self._queue is not None:
                self._queue.set_enhancement_pending(job.node_id)
                return 0
            self._store.replace_node_chunks(job.node_id, [])
            self._clear_extract_artifacts(job)
            return 0

        rows = self._build_rows(job, chunks)
        written = self._store.replace_node_chunks(job.node_id, rows)
        self._replace_basic_extract_artifact(job, text)
        if self.has_advanced_ocr() and self._queue is not None:
            self._queue.set_enhancement_pending(job.node_id)
        return written

    def has_advanced_ocr(self) -> bool:
        return self._advanced_ocr_extract is not None

    def process_enhancement(self, job: IndexingJob, claim_seq: int) -> None:
        """Run local PP-StructureV3 against the PDF and replace body chunks."""
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing pdf: {path}")
        if self._queue is None:
            raise RuntimeError("PdfProcessor enhancement requires queue")
        extractor = self._advanced_ocr_extract
        if extractor is None:
            return

        try:
            advanced_output = extractor(path)
        except Exception as err:
            handle_enhancement_error(self._queue, job.node_id, err, log=LOG)
            return
        advanced_text, advanced_assets = extract_text_and_assets(advanced_output)
        advanced_text = advanced_text.strip()
        if not self._queue.matches_content_claim(
            job.node_id, job.content_version, claim_seq
        ):
            return

        body_chunks = meaningful_chunks(strip_image_references(advanced_text))
        if not body_chunks:
            if not self._has_current_body_chunks(job):
                self._store.replace_chunks_by_role(job.node_id, "body", [])
                self._clear_extract_artifacts(job)
            self._write_extract_artifact(
                job,
                "advanced",
                advanced_text,
                assets=advanced_assets,
            )
            self._queue.clear_enhancement_pending_if_transition_seq(
                job.node_id, claim_seq
            )
            return

        rows = self._build_rows(job, body_chunks)
        self._store.replace_chunks_by_role(job.node_id, "body", rows)
        self._write_extract_artifact(
            job,
            "advanced",
            advanced_text,
            assets=advanced_assets,
        )
        self._queue.clear_enhancement_pending_if_transition_seq(
            job.node_id, claim_seq
        )

    def _build_rows(self, job: IndexingJob, chunks: list[str]) -> list[NodeChunk]:
        now = datetime.now(timezone.utc)
        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )
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
        return rows

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

    def _write_extract_artifact(
        self,
        job: IndexingJob,
        kind: ArtifactKind,
        text: str,
        *,
        assets: ExtractAssets | None = None,
    ) -> None:
        if self._extract_dir is None or not text.strip():
            return
        try:
            write_extract_artifact(
                self._extract_dir,
                job.node_id,
                kind,
                text,
                assets=assets,
            )
        except Exception as err:
            LOG.warning(
                "failed to write %s PDF extract artifact for %s: %s",
                kind,
                job.node_id,
                err,
            )

    def _replace_basic_extract_artifact(self, job: IndexingJob, text: str) -> None:
        self._clear_extract_artifacts(job)
        self._write_extract_artifact(job, "basic", text)

    def _clear_extract_artifacts(self, job: IndexingJob) -> None:
        if self._extract_dir is None:
            return
        try:
            clear_extract_artifacts(self._extract_dir, job.node_id)
        except Exception as err:
            LOG.warning(
                "failed to clear stale PDF extract artifacts for %s: %s",
                job.node_id,
                err,
            )

    def _has_current_body_chunks(self, job: IndexingJob) -> bool:
        return any(
            role_or_default(row) == "body"
            and row.get("content_version") == job.content_version
            for row in self._store.scan(job.node_id)
        )
