from __future__ import annotations

import httpx
import pytest

from search_sidecar.web_search.brave import BraveWebSearchProvider
from search_sidecar.web_search.types import WebSearchError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_brave_search_normalizes_web_results_and_dedupes_urls():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/res/v1/web/search"
        assert req.headers["x-subscription-token"] == "brave-key"
        assert req.url.params["q"] == "事故 费用"
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {
                            "title": "Report",
                            "url": "https://example.test/report",
                            "description": "details",
                        },
                        {
                            "title": "Report duplicate",
                            "url": "https://example.test/report",
                            "description": "duplicate",
                        },
                    ]
                }
            },
        )

    provider = BraveWebSearchProvider(
        api_key_provider=lambda: "brave-key",
        client=_client(handler),
    )

    result = provider.search("事故 费用", count=5)

    assert result.query == "事故 费用"
    assert len(result.sources) == 1
    assert result.sources[0].provider_id == "brave-search"
    assert result.sources[0].url == "https://example.test/report"


def test_brave_search_maps_rate_limit_to_recoverable_error():
    provider = BraveWebSearchProvider(
        api_key_provider=lambda: "brave-key",
        client=_client(lambda _req: httpx.Response(429, json={"error": "slow"})),
    )

    with pytest.raises(WebSearchError, match="rate limited"):
        provider.search("x")
