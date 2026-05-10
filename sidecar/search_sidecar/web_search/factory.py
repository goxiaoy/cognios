"""Build web-search providers from settings."""

from __future__ import annotations

from ..providers.keychain import get_provider_secret
from ..providers.presets import PRESETS
from ..settings import SearchSettings
from .brave import BraveWebSearchProvider


def select_web_search_provider(settings: SearchSettings) -> BraveWebSearchProvider | None:
    feature = settings.features.get("web-search")
    if feature is None or not feature.enabled or feature.provider_id is None:
        return None
    provider = settings.providers.get(feature.provider_id)
    if provider is None or not provider.enabled:
        return None
    preset = PRESETS.get(provider.provider_id)
    if preset is None or "web-search" not in preset.capabilities:
        return None
    if provider.provider_id == "brave-search":
        return BraveWebSearchProvider(
            base_url=provider.base_url or preset.base_url or "https://api.search.brave.com/res/v1",
            api_key_provider=lambda pid=provider.provider_id: _required_key(pid),
        )
    return None


def _required_key(provider_id: str) -> str:
    key = get_provider_secret(provider_id)
    if not key:
        raise RuntimeError(f"API key missing for {provider_id}")
    return key
