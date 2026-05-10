"""``/observability/*`` — aggregate operational statistics for Home."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..index.queue import IndexingQueue
from ..observability import ObservabilityStore

router = APIRouter(prefix="/observability", tags=["observability"])
RECENT_INDEX_DAYS = {7, 30}


def _get_observability(request: Request) -> ObservabilityStore:
    store = getattr(request.app.state, "observability_store", None)
    if store is None:
        raise HTTPException(
            status_code=500,
            detail="observability_store not configured on app.state",
        )
    return store


def _get_queue(request: Request) -> IndexingQueue | None:
    return getattr(request.app.state, "indexing_queue", None)


@router.get("/summary")
def get_observability_summary(request: Request, recent_days: int = 30) -> dict:
    if recent_days not in RECENT_INDEX_DAYS:
        raise HTTPException(status_code=422, detail="recent_days must be 7 or 30")
    queue = _get_queue(request)
    recent_indexed_nodes = (
        queue.recent_indexed_counts(days=recent_days) if queue is not None else []
    )
    return _get_observability(request).summary(
        recent_indexed_nodes=recent_indexed_nodes,
        recent_days=recent_days,
    )
