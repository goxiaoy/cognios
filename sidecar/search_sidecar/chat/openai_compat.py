"""LiteLLM-backed OpenAI-compatible chat provider adapter."""

from __future__ import annotations

from collections.abc import Iterator
import logging
from typing import Callable

import httpx
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .agent_runtime import AgenticProvider
from .litellm_adapter import (
    CompletionCallable,
    litellm_completion,
    litellm_model,
    message_content,
    provider_error,
    stream_chunks,
    usage_dict,
)
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
_LITELLM_TIMEOUT_SECONDS = 120.0

LOG = logging.getLogger("search_sidecar.chat.openai_compat")


class OpenAICompatChatProvider:
    def __init__(
        self,
        *,
        provider_id: str,
        base_url: str,
        model: str,
        api_key_provider: Callable[[], str],
        litellm_provider: str = "openai",
        completion_fn: CompletionCallable = litellm_completion,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.provider_id = provider_id
        self.model = model
        self._base_url = base_url.rstrip("/")
        self._api_key_provider = api_key_provider
        self._litellm_provider = litellm_provider
        self._completion = completion_fn
        self._client = http_client or httpx.Client(timeout=_DEFAULT_TIMEOUT)
        self._owns_client = http_client is None

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        model = request.model or self.model
        messages = messages_for_request(request)
        try:
            api_key = self._api_key_provider()
            response = self._completion(
                model=litellm_model(self._litellm_provider, model),
                messages=messages,
                api_key=api_key,
                api_base=self._base_url,
                timeout=_LITELLM_TIMEOUT_SECONDS,
            )
        except Exception as err:
            raise provider_error(self.provider_id, err, action="chat request") from err
        return ChatGeneration(
            content=message_content(response, provider_id=self.provider_id),
            provider_id=self.provider_id,
            model=model,
            usage=usage_dict(response),
        )

    def generate_stream(
        self, request: ChatGenerationRequest
    ) -> Iterator[ChatGenerationChunk]:
        model = request.model or self.model
        try:
            api_key = self._api_key_provider()
            response = self._completion(
                model=litellm_model(self._litellm_provider, model),
                messages=messages_for_request(request),
                api_key=api_key,
                api_base=self._base_url,
                timeout=_LITELLM_TIMEOUT_SECONDS,
                stream=True,
            )
            yield from stream_chunks(response, provider_id=self.provider_id, model=model)
        except ChatProviderError:
            raise
        except Exception as err:
            raise provider_error(self.provider_id, err, action="chat stream") from err

    def list_models(self) -> ChatModelList:
        try:
            response = self._client.get(
                f"{self._base_url}/models",
                headers={"Authorization": f"Bearer {self._api_key_provider()}"},
            )
            if response.status_code >= 400:
                raise ChatProviderError(
                    f"{self.provider_id}: HTTP {response.status_code}: "
                    f"{response.text[:200]}"
                )
            models = _models_from_payload(response.json())
        except Exception as err:
            LOG.warning(
                "%s: failed to list remote chat models; using configured model %r: %s",
                self.provider_id,
                self.model,
                err,
            )
            return self._fallback_model_list()

        if not models:
            return self._fallback_model_list()

        return ChatModelList(
            provider_id=self.provider_id,
            models=models,
            cached=False,
            cache_expires_at=None,
        )

    def agentic_provider(self, model: str | None = None) -> AgenticProvider:
        model_id = model or self.model
        return AgenticProvider(
            provider_id=self.provider_id,
            model_id=model_id,
            model=OpenAIChatModel(
                model_id,
                provider=OpenAIProvider(
                    base_url=self._base_url,
                    api_key=self._api_key_provider(),
                ),
            ),
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _fallback_model_list(self) -> ChatModelList:
        return ChatModelList(
            provider_id=self.provider_id,
            models=[ChatModel(id=self.model, name=self.model)],
            cached=False,
            cache_expires_at=None,
        )


def _models_from_payload(payload: object) -> list[ChatModel]:
    if not isinstance(payload, dict):
        return []
    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        return []
    models: list[ChatModel] = []
    seen: set[str] = set()
    for item in raw_models:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue
        model_id = model_id.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        models.append(ChatModel(id=model_id, name=model_id))
    return models
