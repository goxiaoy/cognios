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
  chunker ingests as text. Runs only during background enhancement
  and replaces body chunks when it produces useful output.
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
from ..extract_artifacts import (
    ArtifactKind,
    clear_extract_artifacts,
    write_extract_artifact,
)
from ..queue import IndexingJob, IndexingQueue
from .enhancement import (
    AdvancedOcrExtract,
    EnhancementTransientError,
    ExtractAssets,
    classify_enhancement_error as _classify_enhancement_error,
    extract_text_and_assets as _extract_text_and_assets,
    handle_enhancement_error,
    meaningful_chunks as _meaningful_chunks,
    strip_image_references as _strip_image_references,
)

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
        queue: IndexingQueue | None = None,
        ocr_extract: OcrExtract | None = None,
        caption_extract: CaptionExtract | None = None,
        advanced_ocr_extract: AdvancedOcrExtract | None = None,
        extract_dir: Path | None = None,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._queue = queue
        self._ocr_extract = ocr_extract
        self._caption_extract = caption_extract
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
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing image: {path}")

        # Basic pass only. Advanced OCR is a separate background
        # enhancement so every image becomes searchable quickly.
        body_text = _safe_extract(self._ocr_extract, path, label="OCR")
        summary_text = _safe_extract(
            self._caption_extract, path, label="Caption"
        )
        body_chunks = chunk_text(body_text) if body_text else []
        summary_chunks = chunk_text(summary_text) if summary_text else []
        if not body_chunks and not summary_chunks:
            # No extractor yielded usable text. Record as indexed
            # with zero chunks; the runner doesn't retry zero-chunk
            # results because they're a valid steady state.
            self._store.replace_node_chunks(job.node_id, [])
            self._replace_basic_extract_artifacts(job, body_text, summary_text)
            return 0

        rows = self._build_rows(job, body_chunks, summary_chunks)
        written = self._store.replace_node_chunks(job.node_id, rows)
        self._replace_basic_extract_artifacts(job, body_text, summary_text)
        if body_chunks and self.has_advanced_ocr() and self._queue is not None:
            self._queue.set_enhancement_pending(job.node_id)
        return written

    def has_advanced_ocr(self) -> bool:
        return self._advanced_ocr_extract is not None

    def process_enhancement(self, job: IndexingJob, claim_seq: int) -> None:
        """Run the advanced OCR pass and replace body chunks only."""
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing image: {path}")
        if self._queue is None:
            raise RuntimeError("ImageProcessor enhancement requires queue")
        extractor = self._advanced_ocr_extract
        if extractor is None:
            return

        try:
            advanced_output = extractor(path)
        except Exception as err:
            self._handle_enhancement_error(job.node_id, err)
            return
        advanced_text, advanced_assets = _extract_text_and_assets(advanced_output)
        advanced_text = advanced_text.strip()
        if not self._queue.matches_content_claim(
            job.node_id, job.content_version, claim_seq
        ):
            return
        body_chunks = _meaningful_chunks(_strip_image_references(advanced_text))
        if not body_chunks:
            self._write_extract_artifact(
                job,
                "advanced",
                advanced_text,
                assets=advanced_assets,
            )
            self._queue.clear_enhancement_pending(job.node_id)
            return

        rows = self._build_rows(job, body_chunks, [])
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

    def _handle_enhancement_error(self, node_id: str, err: Exception) -> None:
        handle_enhancement_error(
            self._queue,
            node_id,
            err,
            log=LOG,
        )

    def _build_rows(
        self,
        job: IndexingJob,
        body_chunks: list[str],
        summary_chunks: list[str],
    ) -> list[NodeChunk]:
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
                    content_version=job.content_version,
                )
                for i, (chunk, vec) in enumerate(zip(body_chunks, body_vectors))
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
                    content_version=job.content_version,
                )
                for i, (chunk, vec) in enumerate(zip(summary_chunks, summary_vectors))
            )
        return rows

    def _embed(self, chunks: list[str]) -> list[list[float]]:
        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )
        return vectors

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
                "failed to write %s OCR artifact for %s: %s",
                kind,
                job.node_id,
                err,
            )

    def _replace_basic_extract_artifacts(
        self,
        job: IndexingJob,
        body_text: str,
        summary_text: str,
    ) -> None:
        self._clear_extract_artifacts(job)
        self._write_extract_artifact(job, "basic", body_text)
        self._write_extract_artifact(job, "caption", summary_text)

    def _clear_extract_artifacts(self, job: IndexingJob) -> None:
        if self._extract_dir is None:
            return
        try:
            clear_extract_artifacts(self._extract_dir, job.node_id)
        except Exception as err:
            LOG.warning(
                "failed to clear stale OCR artifacts for %s: %s",
                job.node_id,
                err,
            )


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
