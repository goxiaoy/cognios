"""Tests for the keychain wrapper.

Uses ``keyring``'s in-process testing backend so the suite stays
hermetic — no real OS keychain reads, no Security Agent prompts,
no platform dependencies. The wrapper itself is thin; these tests
mostly pin the service-name + account-format conventions so a
future refactor can't silently break cross-process key sharing.
"""

from __future__ import annotations

import keyring
import keyring.backend
import pytest
from keyring.errors import PasswordDeleteError

from search_sidecar.providers import keychain
from search_sidecar.providers.keychain import (
    KeychainUnavailableError,
    SERVICE_NAME,
    delete_provider_secret,
    get_provider_secret,
    has_provider_secret,
)


class _InMemoryBackend(keyring.backend.KeyringBackend):
    """Minimal in-memory backend for hermetic tests."""

    priority = 1.0

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self._store.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self._store:
            raise PasswordDeleteError("no such password")
        del self._store[(service, username)]


@pytest.fixture(autouse=True)
def in_memory_backend(monkeypatch):
    backend = _InMemoryBackend()
    monkeypatch.setattr(keyring, "get_keyring", lambda: backend)
    keyring.set_keyring(backend)
    yield backend


def test_service_name_matches_rust_constant():
    """``cognios-search`` matches Rust's ``SERVICE_NAME`` in
    src-tauri/src/services/secure_storage.rs:17. A typo here would
    silently break cross-process key sharing — both processes would
    read different keychain slots and the cloud embedder would get
    'API key missing'."""
    assert SERVICE_NAME == "cognios-search"


def test_get_returns_none_when_no_entry(in_memory_backend):
    assert get_provider_secret("openai") is None


def test_get_round_trips_value(in_memory_backend):
    in_memory_backend.set_password(SERVICE_NAME, "provider:openai", "sk-xxx")
    assert get_provider_secret("openai") == "sk-xxx"


def test_get_strips_trailing_whitespace(in_memory_backend):
    """A pasted-with-newline key still works."""
    in_memory_backend.set_password(
        SERVICE_NAME, "provider:openai", "sk-xxx\n  "
    )
    assert get_provider_secret("openai") == "sk-xxx"


def test_get_returns_none_for_whitespace_only_value(in_memory_backend):
    in_memory_backend.set_password(SERVICE_NAME, "provider:x", "   \n")
    assert get_provider_secret("x") is None


def test_account_namespace_isolated_from_hf_token(in_memory_backend):
    """The legacy ``hf-token`` slot must not collide with the
    ``provider:*`` namespace introduced for cloud providers."""
    in_memory_backend.set_password(SERVICE_NAME, "hf-token", "hf_real_token")
    in_memory_backend.set_password(
        SERVICE_NAME, "provider:hf-token", "different_value"
    )
    # Reading provider id "hf-token" hits provider:hf-token, NOT the
    # legacy hf-token slot.
    assert get_provider_secret("hf-token") == "different_value"


def test_has_provider_secret_returns_true_when_present(in_memory_backend):
    in_memory_backend.set_password(SERVICE_NAME, "provider:openai", "k")
    assert has_provider_secret("openai") is True


def test_has_provider_secret_returns_false_when_missing(in_memory_backend):
    assert has_provider_secret("openai") is False


def test_has_provider_secret_returns_false_on_backend_unavailable(
    monkeypatch,
):
    """A missing backend looks like 'no secret' for the UI's
    'configured?' indicator — diagnostics happen via get_provider_secret."""

    def boom():
        raise KeychainUnavailableError("backend gone")

    monkeypatch.setattr(keychain, "_import_keyring", lambda: (_ for _ in ()).throw(KeychainUnavailableError("import failed")))
    assert has_provider_secret("openai") is False


def test_delete_removes_entry(in_memory_backend):
    in_memory_backend.set_password(SERVICE_NAME, "provider:openai", "k")
    delete_provider_secret("openai")
    assert get_provider_secret("openai") is None


def test_delete_is_idempotent(in_memory_backend):
    """Deleting a non-existent entry is a no-op (matches Rust's
    ``delete_hf_token`` semantics)."""
    delete_provider_secret("never-existed")  # must not raise


def test_empty_provider_id_rejected():
    with pytest.raises(ValueError, match="provider_id must not be empty"):
        get_provider_secret("")


def test_keychain_unavailable_when_keyring_missing(monkeypatch):
    """If the ``keyring`` package itself can't be imported, callers
    get a clear KeychainUnavailableError rather than ImportError."""

    def fake_import_keyring():
        raise KeychainUnavailableError("keyring package missing")

    monkeypatch.setattr(keychain, "_import_keyring", fake_import_keyring)
    with pytest.raises(KeychainUnavailableError):
        get_provider_secret("openai")
