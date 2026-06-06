"""Build chat providers from persisted feature settings."""

from __future__ import annotations

from ..providers.keychain import get_provider_secret
from ..providers.presets import PRESETS
from ..settings import SearchSettings
from .ollama import OllamaChatProvider
from .openai_compat import OpenAICompatChatProvider
from .provider import ChatProvider


def select_chat_provider(settings: SearchSettings) -> ChatProvider | None:
    feature = settings.features.get("llm")
    if feature is None or not feature.enabled or feature.provider_id is None:
        return None
    provider = settings.providers.get(feature.provider_id)
    if provider is None or not provider.enabled:
        return None
    preset = PRESETS.get(provider.provider_id)
    if preset is None or "llm" not in preset.capabilities:
        return None
    base_url = provider.base_url or preset.base_url
    if provider.provider_id == "local-ollama":
        model = provider.model_per_capability.get("llm") or preset.default_model_per_capability["llm"]
        return OllamaChatProvider(base_url=base_url or "http://127.0.0.1:11434", model=model)
    model = provider.model_per_capability.get("llm") or preset.default_model_per_capability["llm"]
    if preset.auth_kind == "api-key" and base_url:
        return OpenAICompatChatProvider(
            provider_id=provider.provider_id,
            base_url=base_url,
            model=model,
            api_key_provider=lambda pid=provider.provider_id: _required_key(pid),
        )
    return None


def _required_key(provider_id: str) -> str:
    key = get_provider_secret(provider_id)
    if not key:
        raise RuntimeError(f"API key missing for {provider_id}")
    return key
