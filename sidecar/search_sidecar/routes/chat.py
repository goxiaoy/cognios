"""``/chat`` turn orchestration routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..chat.orchestrator import ChatOrchestrator, ChatTurnRequest
from ..chat.types import ChatMessage

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessagePayload(BaseModel):
    role: str
    content: str


class ChatTurnPayload(BaseModel):
    query: str = ""
    messages: list[ChatMessagePayload] = Field(default_factory=list)
    accepted_cluster_ids: list[str] = Field(default_factory=list)
    include_web: bool = True


def _get_orchestrator(request: Request) -> ChatOrchestrator:
    orchestrator = getattr(request.app.state, "chat_orchestrator", None)
    if orchestrator is None:
        raise HTTPException(
            status_code=500,
            detail="chat_orchestrator not configured on app.state",
        )
    return orchestrator


@router.post("/turns")
def post_chat_turn(body: ChatTurnPayload, request: Request) -> dict:
    messages = [
        ChatMessage(role=_role(message.role), content=message.content)
        for message in body.messages
        if message.content.strip()
    ]
    response = _get_orchestrator(request).run_turn(
        ChatTurnRequest(
            query=body.query,
            messages=messages,
            accepted_cluster_ids=body.accepted_cluster_ids,
            include_web=body.include_web,
        )
    )
    return response.to_dict()


def _role(value: str):
    if value in {"system", "user", "assistant"}:
        return value
    raise HTTPException(status_code=422, detail=f"unsupported chat role: {value}")
