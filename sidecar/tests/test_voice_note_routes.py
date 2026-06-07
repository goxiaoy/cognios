from __future__ import annotations

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.chat.orchestrator import ChatOrchestrator
from search_sidecar.chat.retrieval import ChatRetrieval
from search_sidecar.chat.types import ChatGeneration, ChatGenerationRequest, ChatModelList

TOKEN = "0123456789abcdef" * 4


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


class _Retrieval(ChatRetrieval):
    def __init__(self):
        pass

    def retrieve(self, query: str, *, limit: int = 8, include_web: bool = True):
        return [], []


class _SummaryProvider:
    provider_id = "test-llm"
    model = "test-model"

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        assert request.messages[-1].content.startswith("Transcript:")
        return ChatGeneration(
            content='{"summary": "They discussed the launch.", "action_items": ["Ship the build"]}',
            provider_id=self.provider_id,
            model=request.model or self.model,
            usage={"prompt_tokens": 4, "completion_tokens": 3},
        )

    def generate_stream(self, request: ChatGenerationRequest):
        raise NotImplementedError

    def list_models(self) -> ChatModelList:
        raise NotImplementedError


def test_summarize_route_uses_configured_llm_provider():
    app = build_app(
        token=TOKEN,
        chat_orchestrator=ChatOrchestrator(
            retrieval=_Retrieval(),
            chat_provider=_SummaryProvider(),
        ),
    )

    with TestClient(app) as client:
        resp = client.post(
            "/voice-notes/summarize",
            json={"note_id": "note-1", "transcript": "Speaker 1: launch update"},
            headers=_auth_headers(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert body["summary"] == "They discussed the launch."
    assert body["action_items"] == ["Ship the build"]
    assert body["provider"]["providerId"] == "test-llm"


def test_summarize_route_reports_unavailable_without_llm_provider():
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.post(
            "/voice-notes/summarize",
            json={"note_id": "note-1", "transcript": "Speaker 1: launch update"},
            headers=_auth_headers(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unavailable"
    assert body["error"] == "LLM provider unavailable"
