"""Tests for ``needs_restart`` signaling + runner pause coordination."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.chat.orchestrator import ChatOrchestrator
from search_sidecar.chat.retrieval import ChatRetrieval
from search_sidecar.chat.types import ChatModel, ChatModelList
from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.settings import (
    FeatureConfig,
    ProviderConfig,
    boot_signature,
    default_settings,
    save_settings,
)
from search_sidecar.storage import open_store

TOKEN = "0123456789abcdef" * 4


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def stack(tmp_path: Path):
    settings_path = tmp_path / "settings.json"
    save_settings(settings_path, default_settings())
    boot_sig = boot_signature(default_settings())
    store = open_store(tmp_path / "index.lance")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    runner = IndexingRunner(dispatcher=dispatcher)
    app = build_app(
        token=TOKEN,
        indexing_runner=runner,
        lancedb_store=store,
        settings_path=settings_path,
        boot_settings_signature=boot_sig,
    )
    yield app, settings_path, runner


def test_boot_signature_is_deterministic():
    assert boot_signature(default_settings()) == boot_signature(default_settings())


def test_boot_signature_differs_on_provider_swap():
    s1 = default_settings()
    s2 = default_settings()
    s2.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    assert boot_signature(s1) != boot_signature(s2)


def test_boot_signature_unchanged_by_consent_field():
    """Pure UI-state fields don't trigger restart."""
    s1 = default_settings()
    s2 = default_settings()
    s2.cloud_consent_acked = ["openai"]
    assert boot_signature(s1) == boot_signature(s2)


def test_boot_signature_unchanged_by_first_run_skipped():
    s1 = default_settings()
    s2 = default_settings()
    s2.first_run_skipped = True
    assert boot_signature(s1) == boot_signature(s2)


def test_boot_signature_unchanged_by_api_key_ref_change():
    """Key rotation is picked up lazily by the cloud embedder; no
    restart needed."""
    s1 = default_settings()
    s1.providers["openai"] = ProviderConfig(
        provider_id="openai", api_key_ref="env-file://cogios/.env#openai"
    )
    s2 = default_settings()
    s2.providers["openai"] = ProviderConfig(
        provider_id="openai", api_key_ref="env-file://cogios/.env#rotated"
    )
    assert boot_signature(s1) == boot_signature(s2)


def test_boot_signature_unchanged_by_chat_provider_save():
    s1 = default_settings()
    s2 = default_settings()
    s2.providers["local-ollama"] = ProviderConfig(
        provider_id="local-ollama", base_url="http://127.0.0.1:11434"
    )
    assert boot_signature(s1) == boot_signature(s2)


def test_boot_signature_changes_on_bound_model_per_capability_override():
    s1 = default_settings()
    s1.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    s1.providers["openai"] = ProviderConfig(
        provider_id="openai",
        model_per_capability={"embedding": "text-embedding-3-small"},
    )
    s2 = default_settings()
    s2.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    s2.providers["openai"] = ProviderConfig(
        provider_id="openai",
        model_per_capability={"embedding": "text-embedding-3-large"},
    )
    assert boot_signature(s1) != boot_signature(s2)


def test_boot_signature_changes_on_bound_base_url_override():
    s1 = default_settings()
    s1.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    s1.providers["openai"] = ProviderConfig(
        provider_id="openai", base_url="https://api.openai.com/v1"
    )
    s2 = default_settings()
    s2.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    s2.providers["openai"] = ProviderConfig(
        provider_id="openai", base_url="http://localhost:11434/v1"
    )
    assert boot_signature(s1) != boot_signature(s2)


def test_get_settings_returns_needs_restart_false_after_fresh_boot(stack):
    app, _, _ = stack
    with TestClient(app) as client:
        resp = client.get("/settings", headers=_auth())
    assert resp.json()["needs_restart"] is False


def test_get_settings_returns_needs_restart_true_after_external_change(stack):
    """Simulates: user (or a bug) wrote a different provider_id to
    settings.json without going through PUT /settings; next GET sees
    the divergence."""
    app, settings_path, _ = stack
    altered = default_settings()
    altered.features["semantic-search"] = FeatureConfig(
        enabled=True, provider_id="openai"
    )
    save_settings(settings_path, altered)
    with TestClient(app) as client:
        resp = client.get("/settings", headers=_auth())
    assert resp.json()["needs_restart"] is True


def test_put_settings_swap_provider_sets_needs_restart_and_pauses_runner(stack):
    app, _, runner = stack
    payload = default_settings().model_dump(mode="json")
    payload["features"]["semantic-search"]["provider_id"] = "openai"
    payload["providers"]["openai"] = {
        "provider_id": "openai",
        "enabled": True,
        "api_key_ref": "env-file://cogios/.env#openai",
        "base_url": None,
        "model_per_capability": {},
    }
    with TestClient(app) as client:
        resp = client.put("/settings", json=payload, headers=_auth())
    assert resp.json()["needs_restart"] is True
    assert runner.paused is True


def test_put_settings_no_dispatcher_change_keeps_runner_unpaused(stack):
    """Pure UI-state changes (consent, first_run_skipped) must NOT
    pause the runner — that would be a spurious "indexing stopped"
    signal."""
    app, _, runner = stack
    payload = default_settings().model_dump(mode="json")
    payload["cloud_consent_acked"] = ["openai"]
    payload["first_run_skipped"] = True
    with TestClient(app) as client:
        resp = client.put("/settings", json=payload, headers=_auth())
    assert resp.json()["needs_restart"] is False
    assert runner.paused is False


def test_put_settings_saved_ollama_config_refreshes_chat_without_restart(
    stack, monkeypatch
):
    app, _, runner = stack
    app.state.chat_orchestrator = ChatOrchestrator(
        retrieval=ChatRetrieval(search_orchestrator=None),
        chat_provider=None,
    )

    class _RuntimeChatProvider:
        provider_id = "runtime-chat"
        model = "runtime-model"

        def list_models(self) -> ChatModelList:
            return ChatModelList(
                provider_id=self.provider_id,
                models=[ChatModel(id=self.model, name=self.model)],
                cached=False,
                cache_expires_at=None,
            )

    monkeypatch.setattr(
        "search_sidecar.routes.settings.select_chat_provider",
        lambda settings: _RuntimeChatProvider(),
    )

    payload = default_settings().model_dump(mode="json")
    payload["providers"]["local-ollama"] = {
        "provider_id": "local-ollama",
        "enabled": True,
        "api_key_ref": None,
        "base_url": "http://127.0.0.1:11434",
        "model_per_capability": {},
    }
    with TestClient(app) as client:
        put_resp = client.put("/settings", json=payload, headers=_auth())
        models_resp = client.get("/chat/models", headers=_auth())

    assert put_resp.json()["needs_restart"] is False
    assert runner.paused is False
    assert models_resp.json()["state"] == "ready"
    assert models_resp.json()["provider_id"] == "runtime-chat"


def test_runner_pause_state_resyncs_on_get(stack):
    """If the runner was somehow paused but settings have since
    converged back to the boot signature, GET unpauses it."""
    app, _, runner = stack
    runner.set_paused(True)
    with TestClient(app) as client:
        client.get("/settings", headers=_auth())
    assert runner.paused is False


def test_paused_runner_skips_direct_processing(tmp_path: Path):
    """Direct test on the runner pause gate."""
    store = open_store(tmp_path / "index.lance")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    runner = IndexingRunner(dispatcher=dispatcher)

    runner.set_paused(True)
    assert runner.process_direct(
        node_id="11111111-1111-1111-1111-111111111111",
        kind="folder",
        name="x",
    ) == {"status": "paused", "error": "indexing runner is paused"}
    runner.set_paused(False)
    assert runner.process_direct(
        node_id="11111111-1111-1111-1111-111111111111",
        kind="folder",
        name="x",
    )["status"] == "indexed"
