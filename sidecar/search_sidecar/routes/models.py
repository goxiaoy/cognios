"""``/models/*`` HTTP surface — talks to ``ModelManager``.

The route layer adapts the manager's async iterator output into FastAPI
``StreamingResponse``s with ``text/event-stream`` content type for SSE
progress streaming.
"""

from __future__ import annotations

import json
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..models.manager import ModelManager, ProgressEvent

router = APIRouter(prefix="/models", tags=["models"])


def _get_manager(request: Request) -> ModelManager:
    manager = getattr(request.app.state, "model_manager", None)
    if manager is None:
        raise HTTPException(
            status_code=500,
            detail="model_manager not configured on app.state",
        )
    return manager


class DownloadRequest(BaseModel):
    """Body of ``POST /models/download/{role}``.

    Empty in v1 — no shipping role is gated. Kept as a body model so
    a future gated path (signed-URL provider, scoped credential) can
    extend this without breaking the route signature.
    """


@router.get("/status")
def get_status(request: Request) -> dict:
    manager = _get_manager(request)
    statuses = {role: asdict(status) for role, status in manager.status().items()}
    return {"roles": statuses}


@router.post("/download/{role}")
async def download(role: str, body: DownloadRequest, request: Request):
    manager = _get_manager(request)
    spec = manager.manifest.get(role)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"unknown role: {role!r}")

    async def stream():
        try:
            async for event in manager.download(role):
                yield _sse_event(event)
        except RuntimeError as err:
            # e.g. "already downloading"
            yield _sse_event(
                ProgressEvent(role=role, state="error", error=str(err))
            )

    return StreamingResponse(stream(), media_type="text/event-stream")


def _sse_event(event: ProgressEvent) -> str:
    """Format one SSE ``data:`` frame from a ProgressEvent."""
    payload = json.dumps(asdict(event), separators=(",", ":"))
    return f"data: {payload}\n\n"
