from __future__ import annotations

import json

import httpx
import pytest

from search_sidecar.chat.openai_compat import OpenAICompatChatProvider
from search_sidecar.chat.types import ChatGenerationRequest, ChatMessage, ChatProviderError


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_openai_compat_chat_normalizes_successful_response():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/v1/chat/completions"
        assert req.headers["authorization"] == "Bearer sk-test"
        body = json.loads(req.read().decode("utf-8"))
        assert body["model"] == "gpt-4o-mini"
        assert body["messages"][0]["role"] == "system"
        assert "Source context" not in body["messages"][0]["content"]
        assert "Inline citation requirements" in body["messages"][0]["content"]
        assert "workspace label" in body["messages"][0]["content"]
        assert body["messages"][1]["role"] == "user"
        assert "Source context" in body["messages"][1]["content"]
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "事故时间线如下。"}}],
                "usage": {"total_tokens": 12},
            },
        )

    provider = OpenAICompatChatProvider(
        provider_id="openai",
        base_url="https://api.example.test/v1",
        model="gpt-4o-mini",
        api_key_provider=lambda: "sk-test",
        client=_client(handler),
    )

    result = provider.generate(
        ChatGenerationRequest(
            messages=[ChatMessage(role="user", content="总结事故")],
            context=["Source context"],
        )
    )

    assert result.content == "事故时间线如下。"
    assert result.provider_id == "openai"
    assert result.usage == {"total_tokens": 12}


def test_openai_compat_chat_maps_rate_limit_to_provider_error():
    provider = OpenAICompatChatProvider(
        provider_id="openai",
        base_url="https://api.example.test/v1",
        model="gpt-4o-mini",
        api_key_provider=lambda: "sk-test",
        client=_client(lambda _req: httpx.Response(429, json={"error": "slow"})),
    )

    with pytest.raises(ChatProviderError, match="rate limited"):
        provider.generate(ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")]))
