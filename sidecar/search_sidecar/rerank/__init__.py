"""Cross-encoder reranker wrappers.

Mirrors :mod:`search_sidecar.embeddings`: the real ONNX path lives in
:mod:`.gte_reranker` and is imported lazily so the sidecar boots
cleanly without the ``embedding`` extra installed. The factory
returns ``None`` whenever a real reranker can't be constructed —
the orchestrator interprets ``None`` as "skip reranking" rather
than running a degraded reranker that might shuffle results
incorrectly.

The reranker contract is intentionally small: a single
:meth:`Reranker.rerank` call that takes a query + a list of
documents and returns a list of relevance scores in the same order.
The orchestrator owns the slicing and re-sorting around it.
"""

from __future__ import annotations

from typing import Protocol

from .factory import select_reranker
from .gte_reranker import GteReranker, GteRerankerConfig


class Reranker(Protocol):
    """Cross-encoder reranker. Higher score = more relevant."""

    def rerank(self, query: str, documents: list[str]) -> list[float]: ...


__all__ = [
    "GteReranker",
    "GteRerankerConfig",
    "Reranker",
    "select_reranker",
]
