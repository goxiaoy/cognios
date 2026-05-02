"""Image processor.

Indexes images by extracting text via OCR (and, in a follow-up,
captions via a multimodal LLM). The processor is intentionally
free of any paddleocr / llama-server import — those are pulled in by
the **extractor callables** the lifecycle injects, so this module
stays cheap to import and easy to test against mocks.

Architecture:

- ``ocr_extract: Callable[[Path], str]`` — runs OCR on the image and
  returns a single text string. ``None`` disables the OCR path; the
  processor returns 0 chunks.
- ``caption_extract: Callable[[Path], str]`` — calls the local
  ``llama-server`` for an image caption. ``None`` disables the
  caption path. Lands in a follow-up commit once the Rust
  supervisor is ready; stubbed today.

If both extractors are ``None`` the processor still records the
image as "indexed" (0 chunks). That matches the contract used by
TextProcessor for empty files: the runner records the job as
``indexed`` rather than ``error`` so retries don't pile up.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..queue import IndexingJob

LOG = logging.getLogger("search_sidecar.index.processors.image")

# Common raster formats. SVG / PDF are handled elsewhere; HEIC may
# arrive but PIL/PaddleOCR don't decode it without extra deps so we
# leave it off the list for now.
SUPPORTED_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".gif",
)

# Optional callables the lifecycle layer may inject. Type aliases for
# readability — the processor doesn't care how the text was produced,
# only what it looks like once it arrives.
OcrExtract = Callable[[Path], str]
CaptionExtract = Callable[[Path], str]


class ImageProcessor:
    """Processes ``kind="file"`` nodes whose suffix is a supported
    image format. Pulls text via the injected extractors, chunks the
    concatenation, embeds, and upserts.
    """

    KINDS = ("file",)
    EXTENSIONS = SUPPORTED_EXTENSIONS

    def __init__(
        self,
        store: LanceDBStore,
        embedder: Embedder,
        *,
        ocr_extract: OcrExtract | None = None,
        caption_extract: CaptionExtract | None = None,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._ocr_extract = ocr_extract
        self._caption_extract = caption_extract

    def can_handle(self, job: IndexingJob) -> bool:
        if job.kind not in self.KINDS:
            return False
        if job.absolute_content_path is None:
            return False
        suffix = Path(job.absolute_content_path).suffix.lower()
        return suffix in self.EXTENSIONS

    def process(self, job: IndexingJob) -> int:
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing image: {path}")

        # Always replace previous chunks for this node — same contract
        # TextProcessor + PdfProcessor follow.
        self._store.delete_by_node_id(job.node_id)

        document = _build_document(
            path,
            ocr_extract=self._ocr_extract,
            caption_extract=self._caption_extract,
        )
        if not document.strip():
            # No extractor yielded usable text. Record as indexed
            # with zero chunks; the runner doesn't retry zero-chunk
            # results because they're a valid steady state.
            return 0

        chunks = chunk_text(document)
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
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        self._store.upsert(rows)
        return len(rows)


def _build_document(
    path: Path,
    *,
    ocr_extract: OcrExtract | None,
    caption_extract: CaptionExtract | None,
) -> str:
    """Concatenate OCR text and caption with stable section labels.

    Both extractors run independently; if one fails the other still
    contributes. Empty results from either side are skipped — no
    "OCR: \\n" placeholder rows that would dilute FTS scoring.
    """
    parts: list[str] = []
    if ocr_extract is not None:
        try:
            ocr_text = ocr_extract(path) or ""
        except Exception as err:
            LOG.warning("OCR extractor failed for %s: %s", path.name, err)
            ocr_text = ""
        ocr_text = ocr_text.strip()
        if ocr_text:
            parts.append(f"OCR: {ocr_text}")
    if caption_extract is not None:
        try:
            caption_text = caption_extract(path) or ""
        except Exception as err:
            LOG.warning(
                "Caption extractor failed for %s: %s", path.name, err
            )
            caption_text = ""
        caption_text = caption_text.strip()
        if caption_text:
            parts.append(f"Caption: {caption_text}")
    return "\n\n".join(parts)
