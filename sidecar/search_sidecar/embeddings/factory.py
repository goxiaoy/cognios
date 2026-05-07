"""Embedder selection logic.

Three layers of choice:

1. **Settings binding.** If a :class:`SearchSettings` is passed and
   the ``semantic-search`` feature is bound to a known provider,
   the factory routes to that provider. Cloud providers go through
   :class:`OpenAICompatEmbedder` with the API key resolved lazily
   from the OS keychain. Local providers continue to use
   :class:`GteEmbedder` (today's only local option).
2. **Real-vs-stub for local providers.** When the local route is
   chosen, the existing checks apply: ``embedding`` extra installed,
   :class:`ModelManager` reports ready, on-disk files present.
3. **Fallback.** Any failure or missing config returns
   :class:`StubEmbedder`. The orchestrator inspects
   :attr:`Embedder.is_semantic` to choose between hybrid retrieval
   and the FTS-only fallback.

Settings is optional — when it's ``None``, the factory behaves as it
did pre-Unit-2 (defaults to local GTE behavior).
"""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from ..index.embedder import Embedder, StubEmbedder
from ..providers import (
    PRESETS,
    KeychainUnavailableError,
    get_provider_secret,
)
from .gte import GteEmbedder, GteEmbedderConfig
from .openai_compat import OpenAICompatEmbedder

if TYPE_CHECKING:
    from ..models.manager import ModelManager
    from ..settings import SearchSettings

LOG = logging.getLogger("search_sidecar.embeddings.factory")


class EmbedderFactoryError(RuntimeError):
    """Raised when the factory is asked for a real embedder but cannot
    construct one. Callers handle by falling back to ``StubEmbedder``;
    the error stays surfaceable for tests + diagnostics."""


def can_load_real_embedder() -> bool:
    """Cheap check (no module import) for whether the optional
    ``embedding`` extra is installed."""
    return (
        importlib.util.find_spec("onnxruntime") is not None
        and importlib.util.find_spec("transformers") is not None
    )


def select_embedder(
    *,
    model_manager: "ModelManager | None",
    settings: "SearchSettings | None" = None,
    role: str = "embedding",
) -> Embedder:
    """Return the most-capable embedder available right now.

    Order:
    1. If ``settings`` is provided, look at the ``semantic-search``
       feature binding. Cloud provider → :class:`OpenAICompatEmbedder`
       (lazy key from keychain). Unknown provider id → log + fall
       through to local routing.
    2. Local route: real :class:`GteEmbedder` when the extra is
       installed, ``model_manager.is_ready(role)`` is True, and the
       per-role current commit dir contains expected files.
    3. :class:`StubEmbedder` for everything else.

    Failures during construction (missing files, model init crash,
    keychain unavailable) are logged at WARN and fall through to the
    stub. The orchestrator prefers degraded-FTS results to no results.
    """
    cloud = _try_select_cloud_embedder(settings)
    if cloud is not None:
        return cloud
    return _select_local_embedder(model_manager, role)


def _try_select_cloud_embedder(
    settings: "SearchSettings | None",
) -> Embedder | None:
    """If settings binds semantic-search to a cloud provider, build
    that embedder. Returns ``None`` to indicate "fall through to
    local routing" — both for the no-settings case and for
    binding-points-at-local-provider.
    """
    if settings is None:
        return None
    feature = settings.features.get("semantic-search")
    if feature is None or feature.provider_id is None:
        return None
    preset = PRESETS.get(feature.provider_id)
    if preset is None:
        LOG.warning(
            "semantic-search bound to unknown provider_id %r; "
            "falling back to local route",
            feature.provider_id,
        )
        return None
    if preset.provider_type != "cloud":
        # Local provider — local route handles it.
        return None
    if "embedding" not in preset.capabilities:
        LOG.warning(
            "provider %r does not declare embedding capability; "
            "falling back to local route",
            preset.provider_id,
        )
        return None
    if preset.base_url is None:
        LOG.warning(
            "cloud provider %r has no base_url in preset; falling back",
            preset.provider_id,
        )
        return None
    # Resolve model: caller-overridden → preset default → fail.
    provider_cfg = settings.providers.get(preset.provider_id)
    model = (
        (provider_cfg.model_per_capability.get("embedding") if provider_cfg else None)
        or preset.default_model_per_capability.get("embedding")
    )
    if not model:
        LOG.warning(
            "cloud provider %r has no embedding model configured; "
            "falling back to local route",
            preset.provider_id,
        )
        return None
    base_url = (provider_cfg.base_url if provider_cfg else None) or preset.base_url
    LOG.info(
        "cloud embedder selected: provider=%s model=%s base_url=%s",
        preset.provider_id,
        model,
        base_url,
    )
    return OpenAICompatEmbedder(
        base_url=base_url,
        model=model,
        provider_label=preset.provider_id,
        api_key_provider=lambda: _resolve_api_key(preset.provider_id),
    )


def _resolve_api_key(provider_id: str) -> str:
    """Read the API key from the OS keychain at embed-time.

    Lazy resolution is intentional: a key rotation between sidecar
    boot and the next embed call is picked up without restart, and
    the key never sits in the embedder's constructor closure for
    longer than necessary.
    """
    try:
        secret = get_provider_secret(provider_id)
    except KeychainUnavailableError as err:
        raise RuntimeError(
            f"OS keychain unreachable for provider {provider_id!r}: {err}. "
            "On Linux ensure a Secret Service daemon (gnome-keyring / "
            "KeePassXC / kwallet) is running, or install `keyrings.alt`."
        ) from err
    if not secret:
        raise RuntimeError(
            f"no API key configured for provider {provider_id!r} — "
            "add it via Settings → Providers."
        )
    return secret


def _select_local_embedder(
    model_manager: "ModelManager | None",
    role: str,
) -> Embedder:
    """Original local-only selection logic, unchanged behavior for
    callers that don't pass settings."""
    if model_manager is None:
        LOG.debug("no model_manager wired; using StubEmbedder")
        return StubEmbedder()
    if not can_load_real_embedder():
        LOG.debug(
            "embedding extra not installed; using StubEmbedder "
            "(install with `uv sync --extra embedding`)"
        )
        return StubEmbedder()
    if not model_manager.is_ready(role):
        LOG.info(
            "embedding role not ready (state=%s); using StubEmbedder",
            model_manager.status().get(role, None),
        )
        return StubEmbedder()
    model_dir = _resolve_active_model_dir(model_manager, role)
    if model_dir is None:
        return StubEmbedder()
    try:
        return GteEmbedder(GteEmbedderConfig(model_dir=model_dir))
    except Exception as err:  # broad: any load-time fault → fallback
        LOG.warning(
            "failed to load GteEmbedder from %s: %s. Falling back "
            "to StubEmbedder.",
            model_dir,
            err,
        )
        return StubEmbedder()


def _resolve_active_model_dir(
    manager: "ModelManager", role: str
) -> Path | None:
    """Return the on-disk directory holding the active commit's files,
    or ``None`` when the layout is malformed."""
    role_dir = manager.role_dir(role)
    current = role_dir / "current"
    if not current.exists() and not current.is_symlink():
        LOG.warning("missing 'current' symlink under %s", role_dir)
        return None
    # Resolve the symlink target relative to the role dir; ModelManager
    # writes a relative target (the commit name).
    try:
        commit_dir = current.resolve(strict=True)
    except FileNotFoundError:
        LOG.warning("'current' symlink in %s points at a missing dir", role_dir)
        return None
    if not commit_dir.is_dir():
        return None
    return commit_dir
