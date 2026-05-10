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
        assert body["model"] == "qwen2.5:7b"
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
            model="qwen2.5:7b",
        )
    )

    assert result.content == "可以，先看资料簇。"
    assert result.provider_id == "local-ollama"
    assert result.model == "qwen2.5:7b"
    assert result.usage == {"eval_count": 8}


def test_ollama_lists_models_from_tags_endpoint_and_caches_result():
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        assert req.url.path == "/api/tags"
        calls += 1
        return httpx.Response(
            200,
            json={"models": [{"name": "llama3.2"}, {"name": "qwen2.5:7b"}]},
        )

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(handler),
    )

    first = provider.list_models()
    second = provider.list_models()

    assert [model.id for model in first.models] == ["llama3.2", "qwen2.5:7b"]
    assert first.cached is False
    assert second.cached is True
    assert calls == 1


def test_ollama_chat_empty_response_is_recoverable_error():
    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(lambda _req: httpx.Response(200, json={"message": {"content": ""}})),
    )

    with pytest.raises(ChatProviderError, match="empty"):
        provider.generate(ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")]))
