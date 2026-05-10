"""Workspace and web source retrieval for Chat turns."""

from __future__ import annotations

from ..retrieval import SearchOrchestrator, SearchRequest
from ..web_search.brave import BraveWebSearchProvider
from ..web_search.types import WebSearchError
from .sources import ChatSource


class ChatRetrieval:
    def __init__(
        self,
        *,
        search_orchestrator: SearchOrchestrator | None,
        web_search_provider: BraveWebSearchProvider | None = None,
    ) -> None:
        self._search_orchestrator = search_orchestrator
        self._web_search_provider = web_search_provider

    def retrieve(self, query: str, *, limit: int = 8, include_web: bool = True) -> tuple[list[ChatSource], list[str]]:
        sources: list[ChatSource] = []
        warnings: list[str] = []
        if self._search_orchestrator is not None:
            response = self._search_orchestrator.search(SearchRequest(query=query, limit=limit))
            sources.extend(
                ChatSource(
                    source_id=result.node_id,
                    source_kind="workspace",
                    title=result.name,
                    snippet=result.snippet,
                    citation=result.node_id,
                    path=result.path,
                    score=result.score,
                )
                for result in response.results
            )
        else:
            warnings.append("workspace search unavailable")
        if include_web and self._web_search_provider is not None:
            try:
                web = self._web_search_provider.search(query, count=min(limit, 5))
                sources.extend(
                    ChatSource(
                        source_id=source.url,
                        source_kind="web",
                        title=source.title,
                        snippet=source.snippet,
                        citation=source.url,
                        path=None,
                        score=max(0.0, 1.0 - (source.rank * 0.05)),
                    )
                    for source in web.sources
                )
            except (WebSearchError, RuntimeError) as err:
                warnings.append(str(err))
        return sources, warnings
