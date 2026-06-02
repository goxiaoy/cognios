from __future__ import annotations

import json

import httpx
from openai import OpenAI

from search_sidecar.chat.litellm_adapter import litellm_completion


def test_default_completion_uses_openai_compatible_client_without_litellm():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = json.loads(request.content)
        assert request.url.path == "/chat/completions"
        assert request.headers["authorization"] == "Bearer sk-test"
        assert payload["model"] == "deepseek-chat"
        assert payload["messages"] == [{"role": "user", "content": "hello"}]
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 1,
                "model": "deepseek-chat",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "hi"},
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    client = OpenAI(
        api_key="sk-test",
        base_url="https://api.deepseek.test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    response = litellm_completion(
        model="openai/deepseek-chat",
        messages=[{"role": "user", "content": "hello"}],
        api_key="sk-test",
        api_base="https://api.deepseek.test",
        openai_client=client,
    )

    assert response.choices[0].message.content == "hi"
    assert len(requests) == 1
