from __future__ import annotations

from search_sidecar.chat.factory import select_chat_provider
from search_sidecar.chat.openai_compat import OpenAICompatChatProvider
from search_sidecar.chat.ollama import OllamaChatProvider
from search_sidecar.settings import FeatureConfig, ProviderConfig, SearchSettings, default_settings


def test_default_settings_wait_for_saved_ollama_provider():
    provider = select_chat_provider(default_settings())

    assert provider is None


def test_saved_ollama_config_selects_local_chat_provider():
    settings = default_settings()
    settings.providers["local-ollama"] = ProviderConfig(
        provider_id="local-ollama",
        base_url="http://127.0.0.1:11434",
    )
    provider = select_chat_provider(settings)

    assert isinstance(provider, OllamaChatProvider)
    assert provider.model == "llama3.2"


def test_disabled_llm_feature_returns_none():
    settings = default_settings()
    settings.features["llm"].enabled = False

    assert select_chat_provider(settings) is None


def test_non_llm_provider_binding_returns_none():
    settings = SearchSettings(
        providers={"local-gte": ProviderConfig(provider_id="local-gte")},
        features={"llm": FeatureConfig(enabled=True, provider_id="local-gte")},
    )

    assert select_chat_provider(settings) is None


def test_saved_qwen_config_selects_litellm_openai_compatible_provider():
    settings = SearchSettings(
        providers={"qwen-dashscope": ProviderConfig(provider_id="qwen-dashscope")},
        features={"llm": FeatureConfig(enabled=True, provider_id="qwen-dashscope")},
    )

    provider = select_chat_provider(settings)

    assert isinstance(provider, OpenAICompatChatProvider)
    assert provider.provider_id == "qwen-dashscope"
    assert provider.model == "qwen-plus"


def test_saved_deepseek_config_selects_litellm_openai_compatible_provider():
    settings = SearchSettings(
        providers={"deepseek": ProviderConfig(provider_id="deepseek")},
        features={"llm": FeatureConfig(enabled=True, provider_id="deepseek")},
    )

    provider = select_chat_provider(settings)

    assert isinstance(provider, OpenAICompatChatProvider)
    assert provider.provider_id == "deepseek"
    assert provider.model == "deepseek-v4-flash"
