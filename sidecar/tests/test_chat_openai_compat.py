from __future__ import annotations

import pytest

from search_sidecar.chat.openai_compat import OpenAICompatChatProvider
from search_sidecar.chat.types import ChatGenerationRequest, ChatMessage, ChatProviderError


def test_openai_compat_chat_normalizes_successful_response():
    def completion_fn(**kwargs):
        assert kwargs["model"] == "openai/gpt-4o-mini"
        assert kwargs["api_key"] == "sk-test"
        assert kwargs["api_base"] == "https://api.example.test/v1"
        messages = kwargs["messages"]
        assert messages[0]["role"] == "system"
        assert "Source context" not in messages[0]["content"]
        assert "Inline citation requirements" in messages[0]["content"]
        assert "workspace label" in messages[0]["content"]
        assert messages[1]["role"] == "user"
        assert "Source context" in messages[1]["content"]
        return {
            "choices": [{"message": {"content": "事故时间线如下。"}}],
            "usage": {"total_tokens": 12},
        }

    provider = OpenAICompatChatProvider(
        provider_id="openai",
        base_url="https://api.example.test/v1",
        model="gpt-4o-mini",
        api_key_provider=lambda: "sk-test",
        completion_fn=completion_fn,
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
    class RateLimited(Exception):
        status_code = 429

    def completion_fn(**_kwargs):
        raise RateLimited("slow down")

    provider = OpenAICompatChatProvider(
        provider_id="openai",
        base_url="https://api.example.test/v1",
        model="gpt-4o-mini",
        api_key_provider=lambda: "sk-test",
        completion_fn=completion_fn,
    )

    with pytest.raises(ChatProviderError, match="rate limited"):
        provider.generate(ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")]))


def test_openai_compat_chat_streams_litellm_chunks():
    def completion_fn(**kwargs):
        assert kwargs["stream"] is True
        return iter(
            [
                {"choices": [{"delta": {"content": "事"}}]},
                {"choices": [{"delta": {"content": "故"}}], "usage": {"total_tokens": 4}},
            ]
        )

    provider = OpenAICompatChatProvider(
        provider_id="openai",
        base_url="https://api.example.test/v1",
        model="gpt-4o-mini",
        api_key_provider=lambda: "sk-test",
        completion_fn=completion_fn,
    )

    chunks = list(
        provider.generate_stream(
            ChatGenerationRequest(messages=[ChatMessage(role="user", content="x")])
        )
    )

    assert [chunk.content_delta for chunk in chunks[:-1]] == ["事", "故"]
    assert chunks[-1].done is True
    assert chunks[-1].usage == {"total_tokens": 4}
