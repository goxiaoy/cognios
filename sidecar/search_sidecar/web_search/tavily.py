"""Tavily Search API adapter."""

from __future__ import annotations

from typing import Any, Callable

import httpx

from .types import WebSearchError, WebSearchResponse, WebSource, utc_now_iso

_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0)


class TavilyWebSearchProvider:
    provider_id = "tavily-search"

    def __init__(
        self,
        *,
        api_key_provider: Callable[[], str],
        base_url: str = "https://api.tavily.com",
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key_provider = api_key_provider
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)

    def search(
        self,
        query: str,
        *,
        count: int = 5,
        search_depth: str = "basic",
    ) -> WebSearchResponse:
        query = query.strip()
        if not query:
            return WebSearchResponse(query=query, sources=[])
        try:
            api_key = self._api_key_provider()
            response = self._client.post(
                f"{self._base_url}/search",
                json={
                    "query": query,
                    "max_results": max(1, min(count, 10)),
                    "search_depth": search_depth,
                    "include_answer": False,
                    "include_raw_content": False,
                },
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
        except Exception as err:
            raise WebSearchError(f"tavily-search: request failed: {err}") from err
        if response.status_code in (401, 403):
            raise WebSearchError("tavily-search: API key invalid or revoked")
        if response.status_code == 429:
            raise WebSearchError("tavily-search: rate limited")
        if response.status_code >= 400:
            raise WebSearchError(
                f"tavily-search: HTTP {response.status_code}: {response.text[:200]}"
            )
        payload = response.json()
        results = _extract_results(payload)
        retrieved_at = utc_now_iso()
        sources = [
            WebSource(
                title=str(item.get("title") or item.get("url") or "Untitled"),
                url=str(item.get("url") or ""),
                snippet=str(item.get("content") or item.get("snippet") or ""),
                rank=index + 1,
                provider_id=self.provider_id,
                retrieved_at=retrieved_at,
            )
            for index, item in enumerate(results)
            if item.get("url")
        ]
        return WebSearchResponse(query=query, sources=_dedupe_sources(sources))

    def close(self) -> None:
        self._client.close()


def _extract_results(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise WebSearchError("tavily-search: malformed response")
    results = payload.get("results")
    if results is None:
        return []
    if not isinstance(results, list):
        raise WebSearchError("tavily-search: malformed results response")
    return [item for item in results if isinstance(item, dict)]


def _dedupe_sources(sources: list[WebSource]) -> list[WebSource]:
    seen: set[str] = set()
    deduped: list[WebSource] = []
    for source in sources:
        if source.url in seen:
            continue
        seen.add(source.url)
        deduped.append(source)
    return deduped
