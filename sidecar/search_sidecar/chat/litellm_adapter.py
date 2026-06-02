"""Shared OpenAI-compatible chat-completion helpers.

The function names are retained from the earlier LiteLLM adapter so
provider call sites do not need a broad rename.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

from .types import ChatGenerationChunk, ChatProviderError

CompletionCallable = Callable[..., Any]


def litellm_completion(**kwargs: Any) -> Any:
    from openai import OpenAI

    model = kwargs.pop("model")
    messages = kwargs.pop("messages")
    api_base = kwargs.pop("api_base")
    api_key = kwargs.pop("api_key", None) or "ollama"
    timeout = kwargs.pop("timeout", None)
    client = kwargs.pop("openai_client", None) or OpenAI(
        api_key=api_key,
        base_url=api_base,
        timeout=timeout,
    )
    return client.chat.completions.create(
        model=_openai_compatible_model_id(model),
        messages=messages,
        **kwargs,
    )


def litellm_model(provider: str, model: str) -> str:
    prefix = f"{provider}/"
    if model.startswith(prefix):
        return model
    return f"{prefix}{model}"


def _openai_compatible_model_id(model: str) -> str:
    if "/" not in model:
        return model
    provider, model_id = model.split("/", 1)
    if provider in {"openai", "ollama"}:
        return model_id
    return model


def message_content(response: Any, *, provider_id: str) -> str:
    choice = _first_choice(response)
    message = _value(choice, "message")
    content = _content_text(_value(message, "content"))
    if not content.strip():
        raise ChatProviderError(f"{provider_id}: empty chat response")
    return content


def usage_dict(response: Any) -> dict | None:
    usage = _value(response, "usage")
    if usage is None:
        return None
    if isinstance(usage, dict):
        return usage
    model_dump = getattr(usage, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump()
        if isinstance(dumped, dict):
            return {key: value for key, value in dumped.items() if value is not None}
    out = {
        key: _value(usage, key)
        for key in (
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "prompt_eval_count",
            "eval_count",
            "total_duration",
        )
    }
    return {key: value for key, value in out.items() if value is not None} or None


def stream_chunks(
    response: Any, *, provider_id: str, model: str
) -> Iterator[ChatGenerationChunk]:
    usage: dict | None = None
    for frame in response:
        frame_usage = usage_dict(frame)
        if frame_usage:
            usage = frame_usage
        choice = _first_choice(frame, required=False)
        if choice is None:
            continue
        delta = _value(choice, "delta")
        content = _content_text(_value(delta, "content"))
        if content:
            yield ChatGenerationChunk(content_delta=content)
    yield ChatGenerationChunk(
        done=True,
        provider_id=provider_id,
        model=model,
        usage=usage,
    )


def provider_error(provider_id: str, err: Exception, *, action: str) -> ChatProviderError:
    status_code = _status_code(err)
    message = str(err)
    lower = message.lower()
    if status_code == 401 or "401" in lower or "invalid api key" in lower:
        return ChatProviderError(f"{provider_id}: API key invalid or revoked")
    if status_code == 429 or "429" in lower or "rate limit" in lower:
        return ChatProviderError(f"{provider_id}: rate limited")
    if provider_id == "local-ollama" and (
        "connection" in lower or "connect" in lower or "unreachable" in lower
    ):
        return ChatProviderError(f"{provider_id}: local runtime unreachable: {message}")
    return ChatProviderError(f"{provider_id}: {action} failed: {message}")


def _first_choice(response: Any, *, required: bool = True) -> Any:
    choices = _value(response, "choices")
    if isinstance(choices, list) and choices:
        return choices[0]
    if required:
        raise ChatProviderError("litellm: malformed chat response")
    return None


def _value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            text = _value(item, "text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""


def _status_code(err: Exception) -> int | None:
    for attr in ("status_code", "status"):
        value = getattr(err, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(err, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None
