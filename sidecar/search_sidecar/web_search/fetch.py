"""Bounded web preview fetching for Chat context."""

from __future__ import annotations

import httpx

from ..index.processors.url_cache import extract_readable_text
from .types import WebSearchError

_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=10.0)
MAX_PREVIEW_BYTES = 512_000
ALLOWED_CONTENT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")


def fetch_web_preview(
    url: str,
    *,
    client: httpx.Client | None = None,
    max_bytes: int = MAX_PREVIEW_BYTES,
) -> str:
    owned_client = client is None
    http = client or httpx.Client(timeout=_DEFAULT_TIMEOUT, follow_redirects=True)
    try:
        response = http.get(url)
    except httpx.HTTPError as err:
        raise WebSearchError(f"web fetch failed: {err}") from err
    finally:
        if owned_client:
            http.close()
    if response.status_code >= 400:
        raise WebSearchError(f"web fetch HTTP {response.status_code}")
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_CONTENT_TYPES:
        raise WebSearchError(f"unsupported content type: {content_type}")
    body = response.content
    if len(body) > max_bytes:
        raise WebSearchError("web fetch response too large")
    if content_type == "text/plain":
        return response.text.strip()
    return extract_readable_text(body)
