from __future__ import annotations

import json

import httpx
import pytest

from search_sidecar.chat.ollama import OllamaChatProvider
from search_sidecar.chat.types import ChatGenerationRequest, ChatMessage, ChatProviderError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_ollama_chat_sends_history_to_local_chat_endpoint():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/chat"
        body = json.loads(req.read().decode("utf-8"))
        assert body["model"] == "llama3.2"
        assert body["messages"][0]["role"] == "system"
        assert body["messages"][1]["role"] == "user"
        assert body["messages"][2]["content"] == "整理时间线"
        return httpx.Response(
            200,
            json={
                "message": {"role": "assistant", "content": "可以，先看资料簇。"},
                "eval_count": 8,
            },
        )

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(handler),
    )

    result = provider.generate(
        ChatGenerationRequest(
            messages=[ChatMessage(role="user", content="整理时间线")],
            context=["事故照片 Source context"],
        )
    )

    assert result.content == "可以，先看资料簇。"
    assert result.provider_id == "local-ollama"
    assert result.usage == {"eval_count": 8}


def test_ollama_chat_empty_response_is_recoverable_error():
    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(lambda _req: httpx.Response(200, json={"message": {"content": ""}})),
    )

    with pytest.raises(ChatProviderError, match="empty"):
        provider.generate(ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")]))
