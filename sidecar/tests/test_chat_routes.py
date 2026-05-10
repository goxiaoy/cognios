from __future__ import annotations

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.chat.orchestrator import ChatOrchestrator
from search_sidecar.chat.retrieval import ChatRetrieval
from search_sidecar.chat.sources import ChatSource
from search_sidecar.chat.types import ChatGeneration, ChatGenerationRequest

TOKEN = "0123456789abcdef" * 4


class _Retrieval(ChatRetrieval):
    def __init__(self):
        pass

    def retrieve(self, query: str, *, limit: int = 8, include_web: bool = True):
        return [
            ChatSource(
                source_id="n1",
                source_kind="workspace",
                title="事故照片",
                snippet=f"{query} related",
                citation="n1",
                path="事故/照片/a.jpg",
                score=0.8,
            )
        ], []


class _Provider:
    provider_id = "test-provider"
    model = "test-model"

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        assert request.context
        return ChatGeneration(
            content="answer",
            provider_id=self.provider_id,
            model=self.model,
        )


def _auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_chat_turn_route_returns_clusters_before_synthesis():
    app = build_app(
        token=TOKEN,
        chat_orchestrator=ChatOrchestrator(retrieval=_Retrieval(), chat_provider=_Provider()),
    )

    with TestClient(app) as client:
        resp = client.post("/chat/turns", json={"query": "事故"}, headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "awaiting_source_confirmation"
    assert body["clusters"][0]["source_kind"] == "workspace"
    assert body["answer"] is None


def test_chat_turn_route_generates_after_cluster_acceptance():
    app = build_app(
        token=TOKEN,
        chat_orchestrator=ChatOrchestrator(retrieval=_Retrieval(), chat_provider=_Provider()),
    )

    with TestClient(app) as client:
        resp = client.post(
            "/chat/turns",
            json={"query": "事故", "accepted_cluster_ids": ["workspace:事故/照片"]},
            headers=_auth(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "ready"
    assert body["answer"] == "answer"
    assert body["citations"][0]["sourceKind"] == "workspace"
