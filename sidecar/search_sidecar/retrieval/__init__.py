"""Retrieval orchestrator (Phase 2 / Unit 6).

Phase 2 / Unit 6 part 1 ships the FTS-only path. Vector search and
cross-encoder rerank slot in once the real ONNX embedder + reranker
land — the orchestrator's response envelope already carries a
``degraded`` flag for that transition.
"""

from .filters import ParsedQuery, parse_query
from .search import SearchOrchestrator, SearchRequest, SearchResponse, SearchResult

__all__ = [
    "ParsedQuery",
    "parse_query",
    "SearchOrchestrator",
    "SearchRequest",
    "SearchResponse",
    "SearchResult",
]
