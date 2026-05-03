"""Image processor.

Indexes images by extracting text via OCR + captions via a multimodal
LLM. The processor stays free of any paddleocr / llama-server import —
those are pulled in by the **extractor callables** the lifecycle
injects, so this module is cheap to import and easy to test against
mocks.

Architecture:

- ``ocr_extract: Callable[[Path], str]`` — basic OCR (detect+recognize).
  Chunked through ``chunk_text(...)`` and stored as ``role="body"``
  rows. Falls back path when no advanced extractor is wired or it
  returns empty.
- ``advanced_ocr_extract: Callable[[Path], str]`` — layout-aware OCR
  (PP-StructureV3 local, structured-prompt vision for cloud). Emits
  Markdown with embedded GFM tables and LaTeX formulas, which the
  chunker ingests as text. When wired and successful, takes priority
  over ``ocr_extract`` for the body chunks; basic OCR fills in only
  if advanced returns empty.
- ``caption_extract: Callable[[Path], str]`` — short description of
  the image. Stored as ``role="summary"`` rows.

The OCR (basic + advanced) and caption stages run independently — a
failure in one does not block the other from contributing. If
nothing produces text, the processor records the image as "indexed"
with 0 chunks (matches TextProcessor's empty-file contract; the
runner won't retry).
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
AdvancedOcrExtract = Callable[[Path], str]


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
        advanced_ocr_extract: AdvancedOcrExtract | None = None,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._ocr_extract = ocr_extract
        self._caption_extract = caption_extract
        self._advanced_ocr_extract = advanced_ocr_extract

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
        # TextProcessor + PdfProcessor follow. Runs first so a partial
        # re-index where one extractor fails doesn't leave a stale
        # row from the *other* role behind.
        self._store.delete_by_node_id(job.node_id)

        # Body text: prefer the advanced extractor (Markdown with
        # tables / formulas); fall through to basic OCR when advanced
        # is unavailable or returns empty. Chunked together — the
        # downstream search and preview surfaces don't need to know
        # which extractor produced which line.
        body_text = _safe_extract(
            self._advanced_ocr_extract, path, label="AdvancedOCR"
        )
        if not body_text:
            body_text = _safe_extract(
                self._ocr_extract, path, label="OCR"
            )
        summary_text = _safe_extract(
            self._caption_extract, path, label="Caption"
        )
        body_chunks = chunk_text(body_text) if body_text else []
        summary_chunks = chunk_text(summary_text) if summary_text else []
        if not body_chunks and not summary_chunks:
            # No extractor yielded usable text. Record as indexed
            # with zero chunks; the runner doesn't retry zero-chunk
            # results because they're a valid steady state.
            return 0

        now = datetime.now(timezone.utc)
        modified_at = job.modified_at or now
        rows: list[NodeChunk] = []
        if body_chunks:
            body_vectors = self._embed(body_chunks)
            rows.extend(
                NodeChunk(
                    id=f"{job.node_id}:{i}",
                    node_id=job.node_id,
                    kind=job.kind,
                    name=job.name,
                    text=chunk,
                    vector=vec,
                    mount_id=job.mount_id,
                    created_at=job.created_at,
                    modified_at=modified_at,
                    role="body",
                )
                for i, (chunk, vec) in enumerate(
                    zip(body_chunks, body_vectors)
                )
            )
        if summary_chunks:
            summary_vectors = self._embed(summary_chunks)
            rows.extend(
                NodeChunk(
                    id=f"{job.node_id}:summary:{i}",
                    node_id=job.node_id,
                    kind=job.kind,
                    name=job.name,
                    text=chunk,
                    vector=vec,
                    mount_id=job.mount_id,
                    created_at=job.created_at,
                    modified_at=modified_at,
                    role="summary",
                )
                for i, (chunk, vec) in enumerate(
                    zip(summary_chunks, summary_vectors)
                )
            )
        self._store.upsert(rows)
        return len(rows)

    def _embed(self, chunks: list[str]) -> list[list[float]]:
        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )
        return vectors


def _safe_extract(
    extractor: Callable[[Path], str] | None,
    path: Path,
    *,
    label: str,
) -> str:
    """Run ``extractor`` and return its stripped text. Returns ``""``
    if the extractor is ``None``, raises, or yields empty/blank.

    The label is purely for the warning log line so the operator can
    tell OCR failures from caption failures.
    """
    if extractor is None:
        return ""
    try:
        text = extractor(path) or ""
    except Exception as err:
        LOG.warning("%s extractor failed for %s: %s", label, path.name, err)
        return ""
    return text.strip()
