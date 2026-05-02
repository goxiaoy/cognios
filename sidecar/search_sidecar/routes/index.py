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


@router.get("/node/{node_id}/content")
def get_node_content(node_id: str, request: Request) -> dict:
    """Indexed text for a single node. Concatenates every chunk's
    body in chunk-index order and returns it under ``joined``; the
    raw chunk array is also exposed for callers that want richer
    rendering (e.g. one ``<section>`` per chunk).

    Used by the image preview surface: the ImageProcessor stores
    "OCR: ...\\n\\nCaption: ..." under each image node, and the
    UI renders that as markdown in the center pane while the
    inspector shows the raw image.

    Returns ``{node_id, kind, chunks: [], joined: ""}`` for nodes
    that have nothing in lancedb yet (image-only PDF, image with
    no extractors wired, fresh node before the runner drains).
    """
    store = _get_store(request)
    if store is None:
        return {
            "node_id": node_id,
            "kind": None,
            "chunks": [],
            "joined": "",
        }
    rows = store.scan(node_id)
    rows_sorted = sorted(rows, key=_chunk_index_key)
    chunks = [
        {"id": row.get("id"), "text": row.get("text") or ""}
        for row in rows_sorted
    ]
    joined = "\n\n".join(c["text"] for c in chunks if c["text"].strip())
    kind = rows_sorted[0].get("kind") if rows_sorted else None
    return {
        "node_id": node_id,
        "kind": kind,
        "chunks": chunks,
        "joined": joined,
    }


def _chunk_index_key(row: dict) -> int:
    """Chunk ids look like ``<uuid>:<chunk_idx>``. Sort by the
    integer suffix so a 12-chunk document doesn't end up as
    ``[0, 1, 10, 11, 2, 3, ...]`` lexicographically."""
    chunk_id = row.get("id") or ""
    _, _, suffix = chunk_id.rpartition(":")
    try:
        return int(suffix)
    except ValueError:
        return 0


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
