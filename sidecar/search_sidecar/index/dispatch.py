"""``IndexingJob`` -> processor dispatch.

Each processor is a thin can_handle / process pair; the dispatcher
just picks the first that matches. Image OCR + caption extractors
are injected through the constructor (lifecycle resolves them from
settings) so this module stays free of any cloud / model imports.
"""

from __future__ import annotations

from typing import Protocol

from ..storage import LanceDBStore
from .embedder import Embedder
from .processors.image import CaptionExtract, ImageProcessor, OcrExtract
from .processors.pdf import PdfProcessor
from .processors.text import TextProcessor
from .processors.url_cache import URLCacheProcessor
from .queue import IndexingJob


class Processor(Protocol):
    def can_handle(self, job: IndexingJob) -> bool: ...
    def process(self, job: IndexingJob) -> int: ...


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
        ocr_extract: OcrExtract | None = None,
        caption_extract: CaptionExtract | None = None,
    ) -> None:
        self._processors: list[Processor] = [
            TextProcessor(store, embedder),
            PdfProcessor(store, embedder),
            ImageProcessor(
                store,
                embedder,
                ocr_extract=ocr_extract,
                caption_extract=caption_extract,
            ),
            URLCacheProcessor(store, embedder),
        ]

    def find(self, job: IndexingJob) -> Processor | None:
        for proc in self._processors:
            if proc.can_handle(job):
                return proc
        return None
