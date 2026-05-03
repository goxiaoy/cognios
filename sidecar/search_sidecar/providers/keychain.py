"""Thin wrapper around ``keyring`` for cross-process secret access.

Both the Rust supervisor and the Python sidecar read from the same
OS keychain entry under the service name ``cognios-search`` (matching
``src-tauri/src/services/secure_storage.rs``'s ``SERVICE_NAME``
constant). Account names are ``provider:<provider_id>``.

The wrapper:

- Centralizes the service-name + account-prefix convention so a typo
  in one place doesn't silently break cross-process sharing.
- Lazy-imports ``keyring`` so the rest of the sidecar can be imported
  without the dep being installed.
- Caches successful reads in-process to keep the macOS Security
  Agent prompt count down — every ``keyring.get_password`` call
  through ``keyring`` opens a fresh keychain entry, and on a
  freshly-rebuilt binary the OS hasn't committed the user's
  "Always Allow" ACL yet, so back-to-back reads can re-prompt
  even within a single session. First read populates the cache;
  subsequent reads in the same sidecar process never hit the
  keychain.
- Honours the ``COGNIOS_PROVIDER_<ID>_KEY`` env vars (with hyphens
  in the provider id replaced by underscores, uppercased) as a
  dev-mode bypass that skips the keychain entirely. Setting
  ``COGNIOS_PROVIDER_OPENAI_KEY=sk-...`` in a dev shell makes the
  prompt cascade go away regardless of how many times you rebuild.
- Surfaces a single :class:`KeychainUnavailableError` for any
  backend-missing case so callers can decide how to degrade.

Read-only here — writes happen on the Rust side via ``set_secret``
in ``src-tauri/src/services/secure_storage.rs``. The Python sidecar
never *creates* keychain entries.

Cache invalidation: ``invalidate_provider_secret_cache()`` is called
by ``PUT /settings`` so a fresh write on the Rust side (followed by
a settings change) shows up on the next read. The standalone
``delete_provider_secret`` IPC path is rarer and self-heals on the
next settings PUT or sidecar restart — we don't currently push an
invalidation IPC for it.
"""

from __future__ import annotations

import logging
import os
import threading

SERVICE_NAME = "cognios-search"

LOG = logging.getLogger("search_sidecar.providers.keychain")

# Process-lifetime cache. Keyed on provider_id; value is the resolved
# secret or ``None`` when the keychain reported no entry (cached so
# we don't keep prompting for "is this provider configured?" looks).
_CACHE: dict[str, str | None] = {}
_CACHE_LOCK = threading.Lock()


class KeychainUnavailableError(RuntimeError):
    """Raised when the OS keychain backend is not reachable.

    Common causes: ``keyring`` package not installed (dev image w/o
    the dep), Linux without a running Secret Service daemon, locked
    or permission-denied keychain. Callers should surface a clear
    "configure your provider" / "platform keychain unavailable"
    message rather than crash.
    """


def _account_for(provider_id: str) -> str:
    """Stable account-name format: ``provider:<provider_id>``."""
    if not provider_id:
        raise ValueError("provider_id must not be empty")
    return f"provider:{provider_id}"


def _import_keyring():
    """Lazy import so the module is importable without the dep."""
    try:
        import keyring  # type: ignore[import-untyped]
        from keyring.errors import KeyringError  # type: ignore[import-untyped]
    except ImportError as err:
        raise KeychainUnavailableError(
            "the `keyring` Python package is not installed; the sidecar "
            "cannot read provider secrets from the OS keychain"
        ) from err
    return keyring, KeyringError


def _env_var_name(provider_id: str) -> str:
    """Derive the env-var name for a provider's dev-mode override.

    ``openai`` → ``COGNIOS_PROVIDER_OPENAI_KEY``
    ``qwen-dashscope`` → ``COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY``
    """
    return f"COGNIOS_PROVIDER_{provider_id.upper().replace('-', '_')}_KEY"


def _env_override(provider_id: str) -> str | None:
    """Dev-mode bypass: read from an env var instead of the OS
    keychain. Returns ``None`` when the var is absent or empty so
    the keychain fallback runs."""
    raw = os.environ.get(_env_var_name(provider_id))
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def get_provider_secret(provider_id: str) -> str | None:
    """Return the stored secret for ``provider_id`` or ``None`` if no
    entry exists.

    Resolution order:
      1. ``COGNIOS_PROVIDER_<ID>_KEY`` env var (dev bypass).
      2. Process-lifetime cache (populated by the first keychain hit).
      3. The OS keychain — sets the cache as a side effect.

    Raises :class:`KeychainUnavailableError` when the keychain backend
    itself is unreachable (distinct from "the entry exists but is
    empty" which returns ``None``).
    """
    override = _env_override(provider_id)
    if override is not None:
        return override

    with _CACHE_LOCK:
        if provider_id in _CACHE:
            return _CACHE[provider_id]

    keyring, KeyringError = _import_keyring()
    account = _account_for(provider_id)
    try:
        value = keyring.get_password(SERVICE_NAME, account)
    except KeyringError as err:
        LOG.warning(
            "keychain unavailable when reading %s/%s: %s",
            SERVICE_NAME,
            account,
            err,
        )
        raise KeychainUnavailableError(str(err)) from err
    # keyring stores strings as-is; trim trailing whitespace defensively
    # so a key pasted with a newline still works.
    resolved: str | None = (value.strip() or None) if value else None
    with _CACHE_LOCK:
        _CACHE[provider_id] = resolved
    return resolved


def invalidate_provider_secret_cache(provider_id: str | None = None) -> None:
    """Drop cached secrets so the next read goes back to the keychain.

    Called by the settings PUT route after a settings change — the
    user may have rotated a key on the Rust side via ``set_provider_
    secret`` between PUTs and we don't want to serve stale state.

    Pass a specific ``provider_id`` to invalidate one entry, or
    ``None`` (the default) to clear the whole cache.
    """
    with _CACHE_LOCK:
        if provider_id is None:
            _CACHE.clear()
        else:
            _CACHE.pop(provider_id, None)


def has_provider_secret(provider_id: str) -> bool:
    """Convenience wrapper — useful for the Settings UI's "configured?"
    indicator. Returns False on KeychainUnavailableError so a missing
    backend looks like "no secret" rather than crashing the caller;
    real diagnostics happen via :func:`get_provider_secret`.
    """
    try:
        return get_provider_secret(provider_id) is not None
    except KeychainUnavailableError:
        return False


def delete_provider_secret(provider_id: str) -> None:
    """Remove the stored secret. Idempotent: deleting a non-existent
    entry is a no-op rather than an error.

    Always invalidates the in-process cache for ``provider_id`` so
    a subsequent ``get_provider_secret`` doesn't hand back the
    just-deleted value.
    """
    keyring, KeyringError = _import_keyring()
    account = _account_for(provider_id)
    try:
        keyring.delete_password(SERVICE_NAME, account)
    except KeyringError as err:
        # `PasswordDeleteError` is the usual subclass for "no such
        # entry"; we treat it as success since the user's intent
        # ("entry should not exist") is satisfied.
        msg = str(err).lower()
        if "no such password" in msg or "not found" in msg:
            invalidate_provider_secret_cache(provider_id)
            return
        raise KeychainUnavailableError(str(err)) from err
    invalidate_provider_secret_cache(provider_id)
