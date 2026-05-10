from __future__ import annotations

from search_sidecar.chat.factory import select_chat_provider
from search_sidecar.chat.ollama import OllamaChatProvider
from search_sidecar.settings import FeatureConfig, ProviderConfig, SearchSettings, default_settings


def test_default_settings_select_local_ollama_chat_provider():
    provider = select_chat_provider(default_settings())

    assert isinstance(provider, OllamaChatProvider)
    assert provider.model == "llama3.2"


def test_disabled_chat_feature_returns_none():
    settings = default_settings()
    settings.features["chat"].enabled = False

    assert select_chat_provider(settings) is None


def test_non_chat_provider_binding_returns_none():
    settings = SearchSettings(
        providers={"local-gte": ProviderConfig(provider_id="local-gte")},
        features={"chat": FeatureConfig(enabled=True, provider_id="local-gte")},
    )

    assert select_chat_provider(settings) is None
