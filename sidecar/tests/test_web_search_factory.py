from __future__ import annotations

from search_sidecar.settings import FeatureConfig, ProviderConfig, default_settings
from search_sidecar.web_search.factory import select_web_search_provider
from search_sidecar.web_search.tavily import TavilyWebSearchProvider


def test_web_search_factory_selects_tavily(monkeypatch):
    monkeypatch.setattr(
        "search_sidecar.web_search.factory.get_provider_secret",
        lambda provider_id: "tavily-key" if provider_id == "tavily-search" else None,
    )
    settings = default_settings()
    settings.providers["tavily-search"] = ProviderConfig(
        provider_id="tavily-search",
        enabled=True,
    )
    settings.features["web-search"] = FeatureConfig(
        enabled=True,
        provider_id="tavily-search",
    )

    provider = select_web_search_provider(settings)

    try:
        assert isinstance(provider, TavilyWebSearchProvider)
    finally:
        if provider is not None:
            provider.close()
