"""``/topic-memory/*`` proposal routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..storage import LanceDBStore
from ..topic_memory import TopicMemoryProposer

router = APIRouter(prefix="/topic-memory", tags=["topic-memory"])


class TopicMemoryProposePayload(BaseModel):
    max_chunks: int = Field(default=2000, ge=1, le=10_000)
    max_topics: int = Field(default=8, ge=1, le=25)


def _get_store(request: Request) -> LanceDBStore:
    store = getattr(request.app.state, "lancedb_store", None)
    if store is None:
        raise HTTPException(
            status_code=500,
            detail="lancedb_store not configured on app.state",
        )
    return store


@router.post("/propose")
def post_topic_memory_propose(
    body: TopicMemoryProposePayload,
    request: Request,
) -> dict:
    proposer = TopicMemoryProposer(
        _get_store(request),
        max_chunks=body.max_chunks,
        max_topics=body.max_topics,
    )
    return proposer.propose()
