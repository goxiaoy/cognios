from __future__ import annotations

import json

import httpx
import pytest

from search_sidecar.chat.ollama import OllamaChatProvider
from search_sidecar.chat.types import ChatGenerationRequest, ChatMessage, ChatProviderError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_ollama_chat_sends_history_to_local_chat_endpoint():
    def completion_fn(**kwargs):
        assert kwargs["model"] == "ollama/qwen2.5:7b"
        assert kwargs["api_base"] == "http://ollama.test/v1"
        messages = kwargs["messages"]
        assert messages[0]["role"] == "system"
        assert "Inline citation requirements" in messages[0]["content"]
        assert "workspace label" in messages[0]["content"]
        assert messages[1]["role"] == "user"
        assert messages[2]["content"] == "整理时间线"
        return {
            "choices": [{"message": {"content": "可以，先看资料簇。"}}],
            "usage": {"eval_count": 8},
        }

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        completion_fn=completion_fn,
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
        if req.url.path == "/api/tags":
            calls += 1
            return httpx.Response(
                200,
                json={"models": [{"name": "llama3.2"}, {"name": "qwen2.5:7b"}]},
            )
        assert req.url.path == "/api/show"
        return httpx.Response(
            200,
            json={"capabilities": ["completion", "tools"]},
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


def test_ollama_lists_tool_capable_models_first_and_disables_unsupported_models():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={"models": [{"name": "gemma3:4b"}, {"name": "qwen3:4b"}]},
            )
        assert req.url.path == "/api/show"
        body = json.loads(req.read().decode("utf-8"))
        capabilities = (
            ["completion"]
            if body["model"] == "gemma3:4b"
            else ["completion", "tools"]
        )
        return httpx.Response(200, json={"capabilities": capabilities})

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(handler),
    )

    result = provider.list_models()

    assert [model.id for model in result.models] == ["qwen3:4b", "gemma3:4b"]
    assert result.models[0].supports_agentic is True
    assert result.models[0].unavailable_reason is None
    assert result.models[1].supports_agentic is False
    assert "does not support tools" in result.models[1].unavailable_reason


def test_ollama_agentic_provider_returns_none_without_tools_capability():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/show"
        body = json.loads(req.read().decode("utf-8"))
        assert body["model"] == "gemma3:4b"
        return httpx.Response(
            200,
            json={"capabilities": ["completion"]},
        )

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(handler),
    )

    assert provider.agentic_provider("gemma3:4b") is None


def test_ollama_agentic_provider_allows_models_with_tools_capability():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/show"
        return httpx.Response(
            200,
            json={"capabilities": ["completion", "tools"]},
        )

    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        client=_client(handler),
    )

    agentic = provider.agentic_provider("qwen3:4b")

    assert agentic is not None
    assert agentic.provider_id == "local-ollama"
    assert agentic.model_id == "qwen3:4b"


def test_ollama_chat_empty_response_is_recoverable_error():
    provider = OllamaChatProvider(
        base_url="http://ollama.test",
        model="llama3.2",
        completion_fn=lambda **_kwargs: {"choices": [{"message": {"content": ""}}]},
    )

    with pytest.raises(ChatProviderError, match="empty"):
        provider.generate(ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")]))
