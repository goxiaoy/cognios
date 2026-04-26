"""Indexing pipeline — queue + runner + per-content-type processors.

Phase 2 / Unit 5 ships:

- :mod:`search_sidecar.index.queue` — SQLite-backed persistent job queue
- :mod:`search_sidecar.index.runner` — async worker that drains the queue
- :mod:`search_sidecar.index.embedder` — embedding interface (stub for
  now; real ONNX implementation is a follow-up)
- :mod:`search_sidecar.index.processors.text` — text/markdown processor

PDF, image, and URL-cache processors are deferred to follow-up commits
because each pulls a heavyweight dependency (PyMuPDF, paddleocr-onnx,
llama-server HTTP, selectolax) that warrants its own focused commit.
"""

from .embedder import Embedder, StubEmbedder
from .queue import IndexingJob, IndexingQueue, JobState
from .runner import IndexingRunner

__all__ = [
    "Embedder",
    "IndexingJob",
    "IndexingQueue",
    "IndexingRunner",
    "JobState",
    "StubEmbedder",
]
