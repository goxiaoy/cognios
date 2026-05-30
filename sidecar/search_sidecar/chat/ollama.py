"""Ollama local chat provider adapter."""

from __future__ import annotations

import time
from collections.abc import Iterator

import httpx
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.ollama import OllamaProvider

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

_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=180.0, write=30.0, pool=10.0)
_LITELLM_TIMEOUT_SECONDS = 180.0
_MODEL_CACHE_TTL_SECONDS = 60.0


class OllamaChatProvider:
    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "llama3.2",
        client: httpx.Client | None = None,
        completion_fn: CompletionCallable = litellm_completion,
    ) -> None:
        self.provider_id = "local-ollama"
        self.model = model
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)
        self._completion = completion_fn
        self._models_cache: ChatModelList | None = None

    def generate(self, request: ChatGenerationRequest) -> ChatGeneration:
        model = request.model or self.model
        messages = messages_for_request(request)
        try:
            response = self._completion(
                model=litellm_model("ollama", model),
                messages=messages,
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
            response = self._completion(
                model=litellm_model("ollama", model),
                messages=messages_for_request(request),
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
        now = time.time()
        if self._models_cache and (
            self._models_cache.cache_expires_at is None
            or self._models_cache.cache_expires_at > now
        ):
            return ChatModelList(
                provider_id=self.provider_id,
                models=self._models_cache.models,
                cached=True,
                cache_expires_at=self._models_cache.cache_expires_at,
            )
        try:
            response = self._client.get(f"{self._base_url}/api/tags")
        except httpx.HTTPError as err:
            raise ChatProviderError(f"local-ollama: local runtime unreachable: {err}") from err
        if response.status_code >= 400:
            raise ChatProviderError(
                f"local-ollama: HTTP {response.status_code}: {response.text[:200]}"
            )
        payload = response.json()
        raw_models = payload.get("models") if isinstance(payload, dict) else None
        models = []
        if isinstance(raw_models, list):
            for item in raw_models:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                if isinstance(name, str) and name.strip():
                    models.append(ChatModel(id=name, name=name))
        if not models:
            models = [ChatModel(id=self.model, name=self.model)]
        models = self._annotate_model_agentic_support(models)
        expires_at = now + _MODEL_CACHE_TTL_SECONDS
        self._models_cache = ChatModelList(
            provider_id=self.provider_id,
            models=models,
            cached=False,
            cache_expires_at=expires_at,
        )
        return self._models_cache

    def agentic_provider(self, model: str | None = None) -> AgenticProvider | None:
        model_id = model or self.model
        if self._model_supports_tools(model_id) is False:
            return None
        return AgenticProvider(
            provider_id=self.provider_id,
            model_id=model_id,
            model=OpenAIChatModel(
                model_id,
                provider=OllamaProvider(base_url=_ollama_openai_base_url(self._base_url)),
            ),
        )

    def _model_supports_tools(self, model_id: str) -> bool | None:
        try:
            response = self._client.post(
                f"{self._base_url}/api/show",
                json={"model": model_id},
            )
        except httpx.HTTPError as err:
            raise ChatProviderError(f"local-ollama: local runtime unreachable: {err}") from err
        if response.status_code >= 400:
            raise ChatProviderError(
                f"local-ollama: HTTP {response.status_code}: {response.text[:200]}"
            )
        payload = response.json()
        capabilities = payload.get("capabilities") if isinstance(payload, dict) else None
        if not isinstance(capabilities, list):
            return None
        normalized = {item for item in capabilities if isinstance(item, str)}
        return "tools" in normalized

    def _annotate_model_agentic_support(
        self, models: list[ChatModel]
    ) -> list[ChatModel]:
        annotated = []
        for model in models:
            supports_tools = self._model_supports_tools(model.id)
            if supports_tools is False:
                annotated.append(
                    ChatModel(
                        id=model.id,
                        name=model.name,
                        supports_agentic=False,
                        unavailable_reason=(
                            "This Ollama model does not support tools, so it "
                            "cannot be used for agentic chat."
                        ),
                    )
                )
            else:
                annotated.append(model)
        return sorted(annotated, key=lambda item: (not item.supports_agentic, item.name))

    def close(self) -> None:
        self._client.close()


def _ollama_openai_base_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        return normalized
    return f"{normalized}/v1"
