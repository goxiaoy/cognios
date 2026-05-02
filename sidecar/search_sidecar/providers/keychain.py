"""Thin wrapper around ``keyring`` for cross-process secret access.

Both the Rust supervisor and the Python sidecar read from the same
OS keychain entry under the service name ``cognios-search`` (matching
``src-tauri/src/services/secure_storage.rs``'s ``SERVICE_NAME``
constant). Account names are ``provider:<provider_id>`` so the namespace
doesn't collide with the existing ``hf-token`` slot.

The wrapper:

- Centralizes the service-name + account-prefix convention so a typo
  in one place doesn't silently break cross-process sharing (the
  earlier brainstorm review caught the ``cogios``/``cognios`` typo
  exactly this way — kept the mistake from happening twice).
- Lazy-imports ``keyring`` so the rest of the sidecar can be imported
  without the dep being installed (matters for ``pin_manifest``-only
  invocations and for tests that don't touch this code path).
- Surfaces a single :class:`KeychainUnavailableError` for any
  backend-missing / no-Secret-Service-on-Linux case so callers can
  decide how to degrade (the cloud embedder turns it into a clear
  "API key not retrievable" indexing-job error).

Read-only here — writes happen on the Rust side via ``set_secret``
in ``src-tauri/src/services/secure_storage.rs``. The Python sidecar
never *creates* keychain entries; it only reads / probes / deletes
them on user request via the bearer-authed Settings IPC chain.
"""

from __future__ import annotations

import logging

SERVICE_NAME = "cognios-search"

LOG = logging.getLogger("search_sidecar.providers.keychain")


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


def get_provider_secret(provider_id: str) -> str | None:
    """Return the stored secret for ``provider_id`` or ``None`` if no
    entry exists. Raises :class:`KeychainUnavailableError` when the
    backend itself is unreachable (distinct from "the entry exists
    but is empty" which returns ``None`` per ``keyring``'s contract).
    """
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
    if value is None:
        return None
    # keyring stores strings as-is; trim trailing whitespace defensively
    # so a key pasted with a newline still works.
    return value.strip() or None


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
    entry is a no-op rather than an error (matches the existing
    ``delete_hf_token`` semantics in the Rust commands).
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
            return
        raise KeychainUnavailableError(str(err)) from err
