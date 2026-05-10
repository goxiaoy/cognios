"""Brave Search API adapter."""

from __future__ import annotations

from typing import Any, Callable

import httpx

from .types import WebSearchError, WebSearchResponse, WebSource, utc_now_iso

_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=10.0)


class BraveWebSearchProvider:
    provider_id = "brave-search"

    def __init__(
        self,
        *,
        api_key_provider: Callable[[], str],
        base_url: str = "https://api.search.brave.com/res/v1",
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
        country: str | None = None,
        search_lang: str | None = None,
        safesearch: str | None = "moderate",
    ) -> WebSearchResponse:
        query = query.strip()
        if not query:
            return WebSearchResponse(query=query, sources=[])
        try:
            api_key = self._api_key_provider()
            response = self._client.get(
                f"{self._base_url}/web/search",
                params={
                    "q": query,
                    "count": max(1, min(count, 10)),
                    **({"country": country} if country else {}),
                    **({"search_lang": search_lang} if search_lang else {}),
                    **({"safesearch": safesearch} if safesearch else {}),
                },
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": api_key,
                },
            )
        except Exception as err:
            raise WebSearchError(f"brave-search: request failed: {err}") from err
        if response.status_code == 401:
            raise WebSearchError("brave-search: API key invalid or revoked")
        if response.status_code == 429:
            raise WebSearchError("brave-search: rate limited")
        if response.status_code >= 400:
            raise WebSearchError(
                f"brave-search: HTTP {response.status_code}: {response.text[:200]}"
            )
        payload = response.json()
        results = _extract_results(payload)
        retrieved_at = utc_now_iso()
        sources = [
            WebSource(
                title=str(item.get("title") or item.get("url") or "Untitled"),
                url=str(item.get("url") or ""),
                snippet=str(item.get("description") or item.get("snippet") or ""),
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
        raise WebSearchError("brave-search: malformed response")
    web = payload.get("web")
    results = web.get("results") if isinstance(web, dict) else None
    if results is None:
        return []
    if not isinstance(results, list):
        raise WebSearchError("brave-search: malformed web.results response")
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
