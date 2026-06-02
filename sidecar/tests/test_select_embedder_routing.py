"""Tests for the settings-aware select_embedder routing.

Verifies that the new layer (cloud routing via settings.json
binding) doesn't regress the existing local-route behavior, and
that cloud routing degrades cleanly when bindings are missing /
malformed / point at unknown providers.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from search_sidecar.embeddings import select_embedder
from search_sidecar.embeddings.openai_compat import OpenAICompatEmbedder
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.providers import keychain
from search_sidecar.providers.keychain import SECRET_ENV_FILE_OVERRIDE
from search_sidecar.settings import (
    FeatureConfig,
    ProviderConfig,
    SearchSettings,
    default_settings,
)


@pytest.fixture
def secret_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / ".env"
    monkeypatch.setenv(SECRET_ENV_FILE_OVERRIDE, str(path))
    keychain.invalidate_provider_secret_cache()
    return path


def test_no_settings_falls_back_to_local_route():
    """Pre-Unit-2 behavior preserved: callers that don't pass settings
    get the existing local-route logic (StubEmbedder when manager is
    None or the embedding extra isn't installed)."""
    embedder = select_embedder(model_manager=None)
    assert isinstance(embedder, StubEmbedder)


def test_settings_with_local_provider_still_uses_local_route():
    """Default settings bind semantic-search to local-gte. With no
    model_manager wired (test env), this falls through to StubEmbedder
    via the local route — the cloud route does NOT match because
    local-gte is provider_type='local'."""
    embedder = select_embedder(
        model_manager=None,
        settings=default_settings(),
    )
    assert isinstance(embedder, StubEmbedder)


def test_cloud_binding_returns_openai_compat_embedder(secret_env_file: Path):
    """Settings binding semantic-search to openai → cloud embedder."""
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-test-key\n")
    settings = default_settings()
    settings.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="env-file://cogios/.env#openai",
    )
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="openai",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    assert isinstance(embedder, OpenAICompatEmbedder)
    assert embedder.dimension == 768


def test_unknown_provider_id_falls_back_to_local_route():
    """If settings reference a provider that isn't in PRESETS, log
    a warning and fall through to local routing rather than crashing."""
    settings = default_settings()
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="provider-from-the-future",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    # Falls through to local route → StubEmbedder (no model_manager).
    assert isinstance(embedder, StubEmbedder)


def test_provider_without_embedding_capability_falls_back():
    """If a future bug binds semantic-search to a provider that
    doesn't declare 'embedding' (e.g. local-paddleocr → ocr only),
    fall through rather than instantiate a useless cloud embedder."""
    settings = default_settings()
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="local-paddleocr",  # ocr-only, no embedding
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    # local-paddleocr is local — falls into the local route → StubEmbedder.
    assert isinstance(embedder, StubEmbedder)


def test_cloud_provider_uses_per_capability_model_override(secret_env_file: Path):
    """If provider config overrides model_per_capability['embedding'],
    that overrides the preset default."""
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-x\n")
    settings = default_settings()
    settings.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="env-file://cogios/.env#openai",
        model_per_capability={"embedding": "text-embedding-3-large"},
    )
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="openai",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    assert isinstance(embedder, OpenAICompatEmbedder)
    # The model is internal state of the embedder; verify by
    # introspecting the private attr (justified for behavior under test).
    assert embedder._model == "text-embedding-3-large"


def test_cloud_provider_uses_base_url_override(secret_env_file: Path):
    """User-supplied base_url overrides the preset default — supports
    the 'point at OpenAI-compatible Ollama' use case."""
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-x\n")
    settings = default_settings()
    settings.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="env-file://cogios/.env#openai",
        base_url="http://localhost:11434/v1",  # Ollama
    )
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="openai",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    assert isinstance(embedder, OpenAICompatEmbedder)
    assert embedder._base_url == "http://localhost:11434/v1"


def test_cloud_embedder_resolves_key_lazily_from_env_file(secret_env_file: Path):
    """The api_key_provider closure reads the env file at embed-time,
    not at construction time. Set the key AFTER the embedder is
    built and verify the call still works."""
    settings = default_settings()
    settings.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="env-file://cogios/.env#openai",
    )
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="openai",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    assert isinstance(embedder, OpenAICompatEmbedder)
    # Set the key NOW (after construction).
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-late\n")
    # Lazy provider returns the just-set key.
    assert embedder._api_key_provider() == "sk-late"


def test_cloud_embedder_raises_clear_error_when_key_missing(secret_env_file: Path):
    """No key in env file → embed() raises a clear 'configure in
    Settings' error, not a confusing AttributeError or 401."""
    settings = default_settings()
    settings.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="env-file://cogios/.env#openai",
    )
    settings.features["semantic-search"] = FeatureConfig(
        enabled=True,
        provider_id="openai",
    )
    embedder = select_embedder(
        model_manager=None,
        settings=settings,
    )
    assert isinstance(embedder, OpenAICompatEmbedder)
    with pytest.raises(RuntimeError, match="no API key configured"):
        embedder._api_key_provider()
