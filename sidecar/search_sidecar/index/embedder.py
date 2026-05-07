"""Embedding interface + a stub implementation.

Two implementations live under ``search_sidecar``:

- :class:`StubEmbedder` (here) — zero-vector embedder used while no
  real model is loaded. The orchestrator detects this via
  :attr:`Embedder.is_semantic` and routes to the FTS-only path.

- :class:`search_sidecar.embeddings.gte.GteEmbedder` (separate module)
  — wraps ``onnx-community/gte-multilingual-base`` via
  ``onnxruntime``. Only importable when the ``embedding``
  extra is installed (see ``sidecar/pyproject.toml``); the
  :func:`select_embedder` factory falls back to :class:`StubEmbedder`
  when it's not.
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

    @property
    def is_semantic(self) -> bool:
        """``True`` when this embedder produces meaningful vectors.

        The orchestrator inspects this to decide between hybrid
        retrieval (vector + FTS) and the FTS-only fallback. The Stub
        path is "not semantic" because every chunk shares the same
        zero vector — vector retrieval against zero vectors is
        degenerate and would return arbitrary near-neighbours.
        """
        ...

    def embed(self, texts: Iterable[str]) -> list[list[float]]: ...


class StubEmbedder:
    """Returns zero vectors at :data:`EMBEDDING_DIMENSION` length.

    Useful for plumbing tests and dev runs before the real embedder
    ships. Every chunk gets the same vector, so vector retrieval
    against a stub-indexed corpus is meaningless — but FTS works
    and the schema/queue/runner are fully exercised.
    """

    @property
    def dimension(self) -> int:
        return EMBEDDING_DIMENSION

    @property
    def is_semantic(self) -> bool:
        return False

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        zero = [0.0] * EMBEDDING_DIMENSION
        return [zero for _ in texts]
