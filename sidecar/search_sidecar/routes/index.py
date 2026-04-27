"""``/index/*`` — read-only views into the queue + lancedb state.

Used by Rust's ``/healthz`` polling and by future UI surfaces (the
sidebar-footer queue indicator, the inspector's per-node ``indexed_at``
field). All endpoints are bearer-authenticated by the global
middleware.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..index.queue import IndexingQueue, JobState
from ..storage import LanceDBStore

router = APIRouter(prefix="/index", tags=["index"])


def _get_queue(request: Request) -> IndexingQueue:
    queue = getattr(request.app.state, "indexing_queue", None)
    if queue is None:
        raise HTTPException(
            status_code=500,
            detail="indexing_queue not configured on app.state",
        )
    return queue


def _get_store(request: Request) -> LanceDBStore | None:
    return getattr(request.app.state, "lancedb_store", None)


@router.get("/status")
def get_index_status(request: Request) -> dict:
    """Aggregate queue + index health for the sidebar footer."""
    queue = _get_queue(request)
    store = _get_store(request)
    return {
        "queue_depth": queue.queue_depth(),
        "in_flight": queue.in_flight_node_ids(),
        "indexed_chunks": store.count() if store is not None else 0,
    }


@router.get("/status/{node_id}")
def get_node_status(node_id: str, request: Request) -> dict:
    """Per-node status — used by the Inspector panel."""
    queue = _get_queue(request)
    job = queue.get(node_id)
    if job is None:
        return {
            "node_id": node_id,
            "state": "unknown",
            "indexed_at": None,
            "error": None,
            "attempts": 0,
        }
    return {
        "node_id": job.node_id,
        "state": job.state.value,
        "indexed_at": job.indexed_at.isoformat() if job.indexed_at else None,
        "error": job.last_error,
        "attempts": job.attempts,
    }


@router.get("/snapshot")
def get_index_snapshot(request: Request) -> dict:
    """Per-node ``(state, modified_at)`` summary the Rust resync uses
    to compute the diff against ``cognios.db``.

    Returns one entry per node currently tracked by the queue. The
    payload is intentionally lean — no paths, no error strings, no
    indexed_at. Rust's diff only needs ``state`` (to detect "not
    indexed yet") and ``modified_at`` (to detect "cognios has newer
    content").
    """
    queue = _get_queue(request)
    return {"nodes": queue.snapshot()}
