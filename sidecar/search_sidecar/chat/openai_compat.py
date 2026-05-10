"""OpenAI-compatible chat provider adapter."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any, Callable

import httpx

from .prompting import messages_for_request
from .types import (
    ChatGeneration,
    ChatGenerationChunk,
    ChatGenerationRequest,
    ChatModel,
    ChatModelList,
    ChatProviderError,
)

_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=30.0)


class OpenAICompatChatProvider:
    def __init__(
        self,
        *,
        provider_id: str,
        base_url: str,
        model: str,
        api_key_provider: Callable[[], str],
        client: httpx.Client | None = None,
    ) -> None:
        self.provider_id = provider_id
        self.model = model
        self._base_url = base_url.rstrip("/")
        self._api_key_provider = api_key_provider
        self._client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        model = request.model or self.model
        messages = messages_for_request(request)
        payload: dict[str, Any] = {"model": model, "messages": messages}
        try:
            api_key = self._api_key_provider()
            response = self._client.post(
                f"{self._base_url}/chat/completions",
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        except Exception as err:
            raise ChatProviderError(f"{self.provider_id}: chat request failed: {err}") from err
        if response.status_code == 401:
            raise ChatProviderError(f"{self.provider_id}: API key invalid or revoked")
        if response.status_code == 429:
            raise ChatProviderError(f"{self.provider_id}: rate limited")
        if response.status_code >= 400:
            raise ChatProviderError(
                f"{self.provider_id}: HTTP {response.status_code}: {response.text[:200]}"
            )
        payload = response.json()
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as err:
            raise ChatProviderError(f"{self.provider_id}: malformed chat response") from err
        if not isinstance(content, str) or not content.strip():
            raise ChatProviderError(f"{self.provider_id}: empty chat response")
        usage = payload.get("usage") if isinstance(payload, dict) else None
        return ChatGeneration(
            content=content,
            provider_id=self.provider_id,
            model=model,
            usage=usage if isinstance(usage, dict) else None,
        )

    def generate_stream(
        self, request: ChatGenerationRequest
    ) -> Iterator[ChatGenerationChunk]:
        model = request.model or self.model
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages_for_request(request),
            "stream": True,
        }
        try:
            api_key = self._api_key_provider()
            with self._client.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Accept": "text/event-stream",
                },
            ) as response:
                if response.status_code == 401:
                    raise ChatProviderError(f"{self.provider_id}: API key invalid or revoked")
                if response.status_code == 429:
                    raise ChatProviderError(f"{self.provider_id}: rate limited")
                if response.status_code >= 400:
                    raise ChatProviderError(
                        f"{self.provider_id}: HTTP {response.status_code}: {response.read().decode(errors='replace')[:200]}"
                    )
                for line in response.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line.removeprefix("data:").strip()
                    if data == "[DONE]":
                        yield ChatGenerationChunk(
                            done=True,
                            provider_id=self.provider_id,
                            model=model,
                        )
                        return
                    try:
                        frame = json.loads(data)
                    except json.JSONDecodeError as err:
                        raise ChatProviderError(f"{self.provider_id}: malformed stream frame") from err
                    choices = frame.get("choices") if isinstance(frame, dict) else None
                    first = choices[0] if isinstance(choices, list) and choices else None
                    delta = first.get("delta") if isinstance(first, dict) else None
                    content = delta.get("content") if isinstance(delta, dict) else None
                    if isinstance(content, str) and content:
                        yield ChatGenerationChunk(content_delta=content)
        except ChatProviderError:
            raise
        except Exception as err:
            raise ChatProviderError(f"{self.provider_id}: chat stream failed: {err}") from err
        raise ChatProviderError(f"{self.provider_id}: chat stream ended without completion")

    def list_models(self) -> ChatModelList:
        return ChatModelList(
            provider_id=self.provider_id,
            models=[ChatModel(id=self.model, name=self.model)],
            cached=True,
            cache_expires_at=None,
        )

    def close(self) -> None:
        self._client.close()
