"""``POST /search`` route.

Mirrors the IPC contract in the plan Architecture section:

    POST /search   { query, filters?, limit?, cursor? }
                -> { results, degraded, partial?, state? }

``filters`` and ``cursor`` are accepted for forward-compatibility but
not yet consumed — the inline filter syntax in ``query`` is the v1
mechanism, and pagination beyond the first page lands with the
dedicated search view (Unit 9).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..retrieval import SearchOrchestrator, SearchRequest

router = APIRouter(prefix="/search", tags=["search"])


class SearchPayload(BaseModel):
    query: str = ""
    filters: dict | None = None  # forward-compat; ignored in v1
    limit: int | None = None
    cursor: str | None = None  # forward-compat; ignored in v1


def _get_orchestrator(request: Request) -> SearchOrchestrator:
    orch = getattr(request.app.state, "search_orchestrator", None)
    if orch is None:
        raise HTTPException(
            status_code=500,
            detail="search_orchestrator not configured on app.state",
        )
    return orch


@router.post("")
def post_search(body: SearchPayload, request: Request) -> dict:
    orch = _get_orchestrator(request)
    response = orch.search(SearchRequest(query=body.query, limit=body.limit))
    return response.to_dict()
