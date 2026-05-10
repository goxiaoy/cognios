"""``POST /search`` route.

Mirrors the IPC contract in the plan Architecture section:

    POST /search   { query, filters?, limit?, sort?, cursor? }
                -> { results, degraded, partial?, state?, next_cursor? }

``filters`` is accepted for forward-compatibility but not yet
consumed — the inline filter syntax in ``query`` is the v1 mechanism.
``sort`` selects the result ordering (``relevance`` default,
``modified`` descending). ``cursor`` is the opaque pagination token
returned in ``next_cursor`` from a previous page; v1 form is
``offset:N``.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..retrieval import SearchOrchestrator, SearchRequest

router = APIRouter(prefix="/search", tags=["search"])

ALLOWED_SORTS = ("relevance", "modified")


class SearchPayload(BaseModel):
    query: str = ""
    filters: dict | None = None  # forward-compat; ignored in v1
    limit: int | None = None
    sort: str | None = None
    cursor: str | None = None


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
    sort = body.sort if body.sort in ALLOWED_SORTS else "relevance"
    started_at = time.perf_counter()
    ok = False
    try:
        response = orch.search(
            SearchRequest(
                query=body.query,
                limit=body.limit,
                sort=sort,
                cursor=body.cursor,
            )
        )
        ok = True
        return response.to_dict()
    finally:
        store = getattr(request.app.state, "observability_store", None)
        if store is not None:
            store.record_duration(
                "search",
                int((time.perf_counter() - started_at) * 1000),
                ok=ok,
            )
