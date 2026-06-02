"""Provider registry — capabilities, defaults, auth kinds.

A *provider* in this codebase is a configured source of model
capabilities (Local GTE, OpenAI API, etc.). The static preset table
in :mod:`.presets` declares what providers exist, what capabilities
each can serve, and what default model to use per capability. The
user-configured runtime state (which providers have keys, which
features are bound to which providers) lives in :mod:`..settings`.

Reads provider API keys from ``~/.cogios/.env`` via
:mod:`.keychain` so the rest of the sidecar doesn't need to know the
storage details.
"""

from __future__ import annotations

from .keychain import (
    KeychainUnavailableError,
    SecretStoreUnavailableError,
    delete_provider_secret,
    get_provider_secret,
    has_provider_secret,
    invalidate_provider_secret_cache,
)
from .presets import (
    PRESETS,
    AuthKind,
    Capability,
    ProviderPreset,
    ProviderType,
    presets_with_capability,
)

__all__ = [
    "AuthKind",
    "Capability",
    "KeychainUnavailableError",
    "SecretStoreUnavailableError",
    "PRESETS",
    "ProviderPreset",
    "ProviderType",
    "delete_provider_secret",
    "get_provider_secret",
    "has_provider_secret",
    "invalidate_provider_secret_cache",
    "presets_with_capability",
]
