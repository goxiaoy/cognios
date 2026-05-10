from __future__ import annotations

import httpx
import pytest

from search_sidecar.web_search.fetch import fetch_web_preview
from search_sidecar.web_search.types import WebSearchError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_web_preview_extracts_readable_html_without_persisting_body():
    client = _client(
        lambda _req: httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><body><nav>skip</nav><h1>Accident</h1><p>Cost detail.</p></body></html>",
        )
    )

    preview = fetch_web_preview("https://example.test", client=client)

    assert "Accident" in preview
    assert "Cost detail" in preview
    assert "skip" not in preview


def test_fetch_web_preview_rejects_unsupported_content_type():
    client = _client(
        lambda _req: httpx.Response(
            200,
            headers={"content-type": "application/pdf"},
            content=b"%PDF",
        )
    )

    with pytest.raises(WebSearchError, match="unsupported content type"):
        fetch_web_preview("https://example.test/file.pdf", client=client)


def test_fetch_web_preview_rejects_oversized_response():
    client = _client(
        lambda _req: httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            content=b"x" * 20,
        )
    )

    with pytest.raises(WebSearchError, match="too large"):
        fetch_web_preview("https://example.test/large", client=client, max_bytes=10)
