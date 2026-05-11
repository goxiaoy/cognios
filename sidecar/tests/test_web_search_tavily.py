from __future__ import annotations

import httpx
import pytest

from search_sidecar.web_search.tavily import TavilyWebSearchProvider
from search_sidecar.web_search.types import WebSearchError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_tavily_search_normalizes_results_and_dedupes_urls():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/search"
        assert req.headers["authorization"] == "Bearer tavily-key"
        body = req.read().decode()
        assert '"query":"事故 费用"' in body
        assert '"max_results":5' in body
        return httpx.Response(
            200,
            json={
                "query": "事故 费用",
                "results": [
                    {
                        "title": "Report",
                        "url": "https://example.test/report",
                        "content": "details",
                        "score": 0.9,
                    },
                    {
                        "title": "Report duplicate",
                        "url": "https://example.test/report",
                        "content": "duplicate",
                        "score": 0.8,
                    },
                ],
            },
        )

    provider = TavilyWebSearchProvider(
        api_key_provider=lambda: "tavily-key",
        client=_client(handler),
    )

    result = provider.search("事故 费用", count=5)

    assert result.query == "事故 费用"
    assert len(result.sources) == 1
    assert result.sources[0].provider_id == "tavily-search"
    assert result.sources[0].url == "https://example.test/report"
    assert result.sources[0].snippet == "details"


def test_tavily_search_maps_rate_limit_to_recoverable_error():
    provider = TavilyWebSearchProvider(
        api_key_provider=lambda: "tavily-key",
        client=_client(lambda _req: httpx.Response(429, json={"error": "slow"})),
    )

    with pytest.raises(WebSearchError, match="rate limited"):
        provider.search("x")
