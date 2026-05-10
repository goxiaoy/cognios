"""Provider-neutral web source DTOs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class WebSource:
    title: str
    url: str
    snippet: str
    rank: int
    provider_id: str
    retrieved_at: str


@dataclass(frozen=True)
class WebSearchResponse:
    query: str
    sources: list[WebSource]
    error: str | None = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class WebSearchError(RuntimeError):
    """Recoverable web-search provider failure."""
