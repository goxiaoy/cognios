"""``IndexingJob`` -> processor dispatch.

Each processor is a thin can_handle / process pair; the dispatcher
just picks the first that matches. Image OCR + caption extractors
are injected through the constructor (lifecycle resolves them from
settings) so this module stays free of any cloud / model imports.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from ..storage import LanceDBStore
from .embedder import Embedder
from .processors.enhancement import AdvancedOcrExtract
from .processors.image import (
    CaptionExtract,
    ImageProcessor,
    OcrExtract,
    SUPPORTED_EXTENSIONS as IMAGE_EXTENSIONS,
)
from .processors.pdf import SUPPORTED_EXTENSIONS as PDF_EXTENSIONS, PdfProcessor
from .processors.text import TextProcessor
from .processors.url_cache import URLCacheProcessor
from .queue import IndexingJob, IndexingQueue


class Processor(Protocol):
    def can_handle(self, job: IndexingJob) -> bool: ...
    def process(self, job: IndexingJob) -> int: ...


class EnhancementProcessor(Processor, Protocol):
    def has_advanced_ocr(self) -> bool: ...
    def process_enhancement(self, job: IndexingJob, claim_seq: int) -> None: ...


class Dispatcher:
    """Picks the first processor whose ``can_handle`` matches the job.

    Built once per :class:`IndexingRunner`. Adding a new processor is a
    matter of constructing it and appending to ``self._processors``.
    """

    def __init__(
        self,
        *,
        store: LanceDBStore,
        embedder: Embedder,
        queue: IndexingQueue | None = None,
        ocr_extract: OcrExtract | None = None,
        caption_extract: CaptionExtract | None = None,
        advanced_ocr_extract: AdvancedOcrExtract | None = None,
        extract_dir: Path | None = None,
    ) -> None:
        self._advanced_ocr_extract = advanced_ocr_extract
        self.image_processor = ImageProcessor(
            store,
            embedder,
            queue=queue,
            ocr_extract=ocr_extract,
            caption_extract=caption_extract,
            advanced_ocr_extract=advanced_ocr_extract,
            extract_dir=extract_dir,
        )
        self.pdf_processor = PdfProcessor(
            store,
            embedder,
            queue=queue,
            advanced_ocr_extract=(
                advanced_ocr_extract
                if _supports_pdf_advanced_ocr(advanced_ocr_extract)
                else None
            ),
            extract_dir=extract_dir,
        )
        self._processors: list[Processor] = [
            TextProcessor(store, embedder),
            self.pdf_processor,
            self.image_processor,
            URLCacheProcessor(store, embedder),
        ]
        self._enhancement_processors: list[EnhancementProcessor] = [
            self.image_processor,
            self.pdf_processor,
        ]

    def find(self, job: IndexingJob) -> Processor | None:
        for proc in self._processors:
            if proc.can_handle(job):
                return proc
        return None

    def has_advanced_ocr(self) -> bool:
        return any(proc.has_advanced_ocr() for proc in self._enhancement_processors)

    def find_enhancement(self, job: IndexingJob) -> EnhancementProcessor | None:
        for proc in self._enhancement_processors:
            if proc.has_advanced_ocr() and proc.can_handle(job):
                return proc
        return None

    def enhancement_extensions(self) -> tuple[str, ...]:
        extensions: list[str] = []
        if self.image_processor.has_advanced_ocr():
            extensions.extend(IMAGE_EXTENSIONS)
        if self.pdf_processor.has_advanced_ocr():
            extensions.extend(PDF_EXTENSIONS)
        return tuple(extensions)

    def close(self) -> None:
        """Release resources held by long-lived extractors."""
        close = getattr(self._advanced_ocr_extract, "close", None)
        if callable(close):
            close()


def _supports_pdf_advanced_ocr(extractor: AdvancedOcrExtract | None) -> bool:
    if extractor is None:
        return False
    if bool(getattr(extractor, "supports_pdf", False)):
        return True
    bound_owner = getattr(extractor, "__self__", None)
    return bool(getattr(bound_owner, "supports_pdf", False))
