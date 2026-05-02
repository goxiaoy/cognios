"""Provider registry — capabilities, defaults, auth kinds.

A *provider* in this codebase is a configured source of model
capabilities (Local GTE, OpenAI API, etc.). The static preset table
in :mod:`.presets` declares what providers exist, what capabilities
each can serve, and what default model to use per capability. The
user-configured runtime state (which providers have keys, which
features are bound to which providers) lives in :mod:`..settings`.

Reads from the OS keychain via :mod:`.keychain`, which wraps
``keyring`` so the rest of the sidecar doesn't need to know about
the platform-specific backends.
"""

from __future__ import annotations

from .keychain import (
    KeychainUnavailableError,
    delete_provider_secret,
    get_provider_secret,
    has_provider_secret,
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
    "PRESETS",
    "ProviderPreset",
    "ProviderType",
    "delete_provider_secret",
    "get_provider_secret",
    "has_provider_secret",
    "presets_with_capability",
]
