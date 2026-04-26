"""``IndexingJob`` -> processor dispatch.

Phase 2 / Unit 5 ships text only. PDF, image, and url_cache
processors land in follow-up commits and register here.
"""

from __future__ import annotations

from typing import Protocol

from ..storage import LanceDBStore
from .embedder import Embedder
from .processors.text import TextProcessor
from .queue import IndexingJob


class Processor(Protocol):
    def can_handle(self, job: IndexingJob) -> bool: ...
    def process(self, job: IndexingJob) -> int: ...


class Dispatcher:
    """Picks the first processor whose ``can_handle`` matches the job.

    Built once per :class:`IndexingRunner`. Adding a new processor is a
    matter of constructing it and appending to ``self._processors``.
    """

    def __init__(self, *, store: LanceDBStore, embedder: Embedder) -> None:
        self._processors: list[Processor] = [
            TextProcessor(store, embedder),
        ]

    def find(self, job: IndexingJob) -> Processor | None:
        for proc in self._processors:
            if proc.can_handle(job):
                return proc
        return None
