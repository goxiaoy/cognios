"""Embedding interface + a stub implementation.

The real ONNX-based embedder (loading
``onnx-community/gte-multilingual-base`` via
``optimum.onnxruntime.ORTModelForFeatureExtraction``) is a follow-up
commit on this branch — it depends on the embedding manifest's commit
hash being resolved (see :mod:`search_sidecar.models.manifest`) and
on the model file actually being downloaded.

Until then, the indexing pipeline runs against :class:`StubEmbedder`
which returns deterministic zero vectors at the right dimension. That
is enough to validate every other layer (queue, runner, lancedb upsert,
event ingestion) end-to-end without depending on a downloaded model.
"""

from __future__ import annotations

from typing import Iterable, Protocol

from ..storage import EMBEDDING_DIMENSION


class Embedder(Protocol):
    """Synchronous text-to-vector embedder.

    Sync because lancedb is sync and we run the runner on a worker
    thread; switching to async is a perf-tuning concern, not a
    correctness one.
    """

    @property
    def dimension(self) -> int: ...

    def embed(self, texts: Iterable[str]) -> list[list[float]]: ...


class StubEmbedder:
    """Returns zero vectors at :data:`EMBEDDING_DIMENSION` length.

    Useful for plumbing tests and dev runs before the real embedder
    ships. Every chunk gets the same vector, so vector retrieval
    against a stub-indexed corpus is meaningless — but FTS works
    (Unit 6) and the schema/queue/runner are fully exercised.
    """

    @property
    def dimension(self) -> int:
        return EMBEDDING_DIMENSION

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        zero = [0.0] * EMBEDDING_DIMENSION
        return [zero for _ in texts]
