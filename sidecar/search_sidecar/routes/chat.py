"""``/chat`` turn orchestration routes."""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..chat.orchestrator import ChatContextNode, ChatOrchestrator, ChatTurnRequest
from ..chat.ollama import OllamaChatProvider
from ..chat.types import ChatMessage, ChatProviderError

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessagePayload(BaseModel):
    role: str
    content: str


class ChatContextNodePayload(BaseModel):
    node_id: str
    title: str
    kind: str | None = None
    path: str | None = None
    snippet: str | None = None
    content: str | None = None


class ChatTurnPayload(BaseModel):
    query: str = ""
    messages: list[ChatMessagePayload] = Field(default_factory=list)
    accepted_cluster_ids: list[str] = Field(default_factory=list)
    include_web: bool = True
    model: str | None = None
    context_nodes: list[ChatContextNodePayload] = Field(default_factory=list)


class ChatProviderTestPayload(BaseModel):
    provider_id: str
    base_url: str | None = None


def _get_orchestrator(request: Request) -> ChatOrchestrator:
    orchestrator = getattr(request.app.state, "chat_orchestrator", None)
    if orchestrator is None:
        raise HTTPException(
            status_code=500,
            detail="chat_orchestrator not configured on app.state",
        )
    return orchestrator


@router.get("/models")
def get_chat_models(request: Request) -> dict:
    orchestrator = _get_orchestrator(request)
    try:
        result = orchestrator.list_models()
    except ChatProviderError as err:
        return {
            "state": "provider_error",
            "provider_id": None,
            "models": [],
            "cached": False,
            "warnings": [str(err)],
        }
    if result is None:
        return {
            "state": "provider_unavailable",
            "provider_id": None,
            "models": [],
            "cached": False,
            "warnings": ["chat provider unavailable"],
        }
    return {
        "state": "ready",
        "provider_id": result.provider_id,
        "models": [model.__dict__ for model in result.models],
        "cached": result.cached,
        "cache_expires_at": result.cache_expires_at,
        "warnings": [],
    }


@router.post("/providers/test")
def post_chat_provider_test(body: ChatProviderTestPayload) -> dict:
    if body.provider_id != "local-ollama":
        raise HTTPException(
            status_code=422,
            detail=f"unsupported chat provider test: {body.provider_id}",
        )

    provider = OllamaChatProvider(
        base_url=(body.base_url or "http://127.0.0.1:11434").strip()
        or "http://127.0.0.1:11434"
    )
    try:
        result = provider.list_models()
    except ChatProviderError as err:
        return {
            "state": "provider_error",
            "provider_id": body.provider_id,
            "models": [],
            "cached": False,
            "warnings": [str(err)],
        }
    finally:
        provider.close()

    return {
        "state": "ready",
        "provider_id": result.provider_id,
        "models": [model.__dict__ for model in result.models],
        "cached": result.cached,
        "cache_expires_at": result.cache_expires_at,
        "warnings": [],
    }


@router.post("/turns")
def post_chat_turn(body: ChatTurnPayload, request: Request) -> dict:
    response = _get_orchestrator(request).run_turn(_turn_request(body))
    return response.to_dict()


@router.post("/turns/stream")
def post_chat_turn_stream(body: ChatTurnPayload, request: Request):
    orchestrator = _get_orchestrator(request)
    turn_request = _turn_request(body)

    def stream():
        for event in orchestrator.stream_turn(turn_request):
            yield _sse_event(event.to_dict())

    return StreamingResponse(stream(), media_type="text/event-stream")


def _turn_request(body: ChatTurnPayload) -> ChatTurnRequest:
    messages = [
        ChatMessage(role=_role(message.role), content=message.content)
        for message in body.messages
        if message.content.strip()
    ]
    return ChatTurnRequest(
        query=body.query,
        messages=messages,
        accepted_cluster_ids=body.accepted_cluster_ids,
        include_web=body.include_web,
        model=body.model,
        context_nodes=[
            ChatContextNode(
                node_id=node.node_id,
                title=node.title,
                kind=node.kind,
                path=node.path,
                snippet=node.snippet,
                content=node.content,
            )
            for node in body.context_nodes
        ],
    )


def _sse_event(event: dict) -> str:
    payload = json.dumps(event, separators=(",", ":"))
    return f"data: {payload}\n\n"


def _role(value: str):
    if value in {"system", "user", "assistant"}:
        return value
    raise HTTPException(status_code=422, detail=f"unsupported chat role: {value}")
