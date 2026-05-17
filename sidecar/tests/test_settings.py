"""Pure-module tests for the settings persistence layer."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest
from pydantic import ValidationError

from search_sidecar.settings import (
    CURRENT_VERSION,
    FeatureConfig,
    ProviderConfig,
    SearchSettings,
    SettingsVersionError,
    default_settings,
    load_settings,
    migrate_mandatory_features,
    save_settings,
)


def test_default_settings_seeds_local_gte_and_semantic_search():
    s = default_settings()
    assert s.version == CURRENT_VERSION
    assert "local-gte" in s.providers
    assert s.providers["local-gte"].provider_id == "local-gte"
    assert s.providers["local-gte"].enabled is True
    assert s.features["semantic-search"].enabled is True
    assert s.features["semantic-search"].provider_id == "local-gte"
    # Mandatory reranking is pre-bound to the local cross-encoder so
    # search boots into a working full-pipeline state once first-run
    # downloads complete.
    assert "local-gte-reranker" in s.providers
    assert s.providers["local-gte-reranker"].enabled is True
    assert s.features["result-reranking"].enabled is True
    assert (
        s.features["result-reranking"].provider_id == "local-gte-reranker"
    )
    # Mandatory image-ocr is pre-bound to local PaddleOCR — the
    # PaddleOCR weights ship inside the rapidocr-onnxruntime wheel,
    # so there's no download cost to making it on-by-default.
    assert "local-paddleocr" in s.providers
    assert s.providers["local-paddleocr"].enabled is True
    assert s.features["image-ocr"].enabled is True
    assert s.features["image-ocr"].provider_id == "local-paddleocr"
    # Image captioning is still optional pending the local Gemma path.
    assert s.features["image-captioning"].enabled is False
    assert s.features["image-captioning"].provider_id is None
    # Advanced OCR (PP-StructureV3 local, structured-prompt vision
    # for cloud) is opt-in: local needs ~600MB of model downloads
    # and cloud incurs per-image API cost. Off + unbound by default.
    assert s.features["advanced-ocr"].enabled is False
    assert s.features["advanced-ocr"].provider_id is None
    # Voice Notes is enabled by default and bound to the local Qwen
    # ASR provider so the shared first-run model downloader can start
    # preparing transcription without a separate bootstrap path.
    assert "local-qwen-asr" in s.providers
    assert s.providers["local-qwen-asr"].enabled is True
    assert s.features["voice-notes"].enabled is True
    assert s.features["voice-notes"].provider_id == "local-qwen-asr"
    # Chat is pre-bound to local Ollama, but the provider is not
    # considered ready until the user opens Add and saves the default
    # endpoint. This keeps first launch from claiming Ollama is ready
    # before the user has acknowledged the runtime configuration.
    assert "local-ollama" not in s.providers
    assert s.features["chat"].enabled is True
    assert s.features["chat"].provider_id == "local-ollama"
    assert s.features["web-search"].enabled is False
    assert s.features["web-search"].provider_id is None
    # No cloud providers consented to on first install.
    assert s.cloud_consent_acked == []
    assert s.first_run_skipped is False


def test_load_settings_returns_defaults_when_file_missing(tmp_path: Path):
    s = load_settings(tmp_path / "absent.json")
    assert s == default_settings()


def test_save_then_load_round_trips(tmp_path: Path):
    path = tmp_path / "settings.json"
    s = default_settings()
    s.cloud_consent_acked = ["openai"]
    s.providers["openai"] = ProviderConfig(
        provider_id="openai",
        api_key_ref="keychain://cognios-search/provider:openai",
    )
    save_settings(path, s)
    loaded = load_settings(path)
    assert loaded == s
    assert loaded.providers["openai"].api_key_ref == (
        "keychain://cognios-search/provider:openai"
    )


def test_save_settings_writes_mode_0600(tmp_path: Path):
    path = tmp_path / "settings.json"
    save_settings(path, default_settings())
    mode = stat.S_IMODE(os.stat(path).st_mode)
    # On POSIX the mode is enforced; on Windows os.open ignores the
    # bits and we'd have to do something else. Skip the assertion on
    # Windows where the test is meaningless.
    if os.name == "posix":
        assert mode == 0o600, f"expected 0o600, got {oct(mode)}"


def test_save_settings_atomic_no_partial_file_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """If os.replace raises every retry, the final file must not exist
    (the tmp file is cleaned up; nothing was committed)."""
    path = tmp_path / "settings.json"

    def always_fails(_src: str, _dst: str) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr("search_sidecar.settings.os.replace", always_fails)
    with pytest.raises(OSError, match="simulated replace failure"):
        save_settings(path, default_settings())
    assert not path.exists()
    # Tmp file should also be cleaned up — no orphan.
    assert not (path.with_name(path.name + ".tmp")).exists()


def test_save_settings_retries_transient_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Transient OSError on first attempt → retry succeeds on second."""
    path = tmp_path / "settings.json"
    real_replace = os.replace
    call_count = {"n": 0}

    def flaky_replace(src: str, dst: str) -> None:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise OSError("transient — gone next time")
        real_replace(src, dst)

    monkeypatch.setattr("search_sidecar.settings.os.replace", flaky_replace)
    save_settings(path, default_settings())
    assert path.exists()
    assert call_count["n"] == 2


def test_load_settings_rejects_future_version(tmp_path: Path):
    path = tmp_path / "settings.json"
    payload = {
        "version": CURRENT_VERSION + 1,
        "providers": {},
        "features": {},
        "cloud_consent_acked": [],
        "first_run_skipped": False,
    }
    path.write_text(json.dumps(payload))
    with pytest.raises(SettingsVersionError, match="version"):
        load_settings(path)


def test_load_settings_drops_unknown_fields_silently(tmp_path: Path):
    """Forward-compat: a future sidecar may add fields. Older sidecars
    must not crash on them."""
    path = tmp_path / "settings.json"
    payload = {
        "version": CURRENT_VERSION,
        "providers": {},
        "features": {},
        "cloud_consent_acked": [],
        "first_run_skipped": False,
        "future_field_we_do_not_understand": {"complex": "value"},
    }
    path.write_text(json.dumps(payload))
    loaded = load_settings(path)
    # Unknown field is dropped, not raised.
    assert loaded.version == CURRENT_VERSION
    # Re-saving doesn't preserve it (intentional — caller cannot
    # round-trip data the model doesn't know about).
    save_settings(path, loaded)
    on_disk = json.loads(path.read_text())
    assert "future_field_we_do_not_understand" not in on_disk


def test_load_settings_propagates_validation_error_on_bad_json(tmp_path: Path):
    path = tmp_path / "settings.json"
    path.write_text("{not valid json")
    with pytest.raises(ValidationError):
        load_settings(path)


def test_load_settings_propagates_validation_error_on_wrong_shape(
    tmp_path: Path,
):
    path = tmp_path / "settings.json"
    # version present but providers is a list, not a dict — should fail
    # validation, not silently coerce.
    path.write_text(
        json.dumps({"version": 1, "providers": [], "features": {}})
    )
    with pytest.raises(ValidationError):
        load_settings(path)


def test_provider_config_requires_non_empty_provider_id():
    with pytest.raises(ValidationError):
        ProviderConfig(provider_id="")


def test_feature_config_default_state():
    f = FeatureConfig()
    assert f.enabled is False
    assert f.provider_id is None


def test_save_settings_idempotent_repeat(tmp_path: Path):
    """Saving the same content twice produces an identical file
    (no growing file from an append bug, no permission drift)."""
    path = tmp_path / "settings.json"
    save_settings(path, default_settings())
    first_bytes = path.read_bytes()
    first_mode = stat.S_IMODE(os.stat(path).st_mode)
    save_settings(path, default_settings())
    second_bytes = path.read_bytes()
    second_mode = stat.S_IMODE(os.stat(path).st_mode)
    assert first_bytes == second_bytes
    assert first_mode == second_mode


# ---- migrate_mandatory_features ---------------------------------------------


def test_migrate_backfills_pre_mandatory_local_features():
    """Pre-mandatory installs persisted ``result-reranking`` as
    ``{enabled: false, providerId: null}``. Boot-time migration must
    restore the default binding so the user isn't stuck with no
    provider picker (the row is now a Required badge). Voice Notes is
    also required now and must default back to local Qwen ASR."""
    settings = SearchSettings(
        providers={
            "local-gte": ProviderConfig(provider_id="local-gte"),
        },
        features={
            "semantic-search": FeatureConfig(
                enabled=True, provider_id="local-gte"
            ),
            "result-reranking": FeatureConfig(enabled=False, provider_id=None),
            "voice-notes": FeatureConfig(enabled=False, provider_id=None),
        },
    )
    migrated, changed = migrate_mandatory_features(settings)
    assert changed is True
    assert migrated.features["result-reranking"].enabled is True
    assert (
        migrated.features["result-reranking"].provider_id == "local-gte-reranker"
    )
    assert migrated.features["voice-notes"].enabled is True
    assert migrated.features["voice-notes"].provider_id == "local-qwen-asr"
    assert "local-gte-reranker" in migrated.providers
    assert "local-qwen-asr" in migrated.providers


def test_migrate_preserves_explicit_non_default_binding():
    """If the user picked some other provider for a mandatory feature,
    the migration must not undo that choice."""
    settings = SearchSettings(
        providers={
            "openai": ProviderConfig(provider_id="openai", enabled=True),
        },
        features={
            "semantic-search": FeatureConfig(
                enabled=True, provider_id="openai"
            ),
            "result-reranking": FeatureConfig(
                enabled=True, provider_id="local-gte-reranker"
            ),
        },
    )
    migrated, changed = migrate_mandatory_features(settings)
    assert changed is True  # provider entry for local-gte-reranker added
    assert migrated.features["semantic-search"].provider_id == "openai"


def test_migrate_no_changes_for_already_migrated_settings():
    """Calling the migration twice is idempotent — second call is a
    no-op once mandatory features already point at their defaults."""
    first, first_changed = migrate_mandatory_features(default_settings())
    assert first_changed is False
    _, second_changed = migrate_mandatory_features(first)
    assert second_changed is False


def test_load_settings_does_not_run_migration(tmp_path: Path):
    """``load_settings`` is a pure file reader. PUT-then-GET must
    return exactly what was written, even if it leaves a mandatory
    feature unbound — the migration only fires from boot-time
    lifecycle, not on every read."""
    path = tmp_path / "settings.json"
    raw = SearchSettings(
        features={
            "result-reranking": FeatureConfig(enabled=False, provider_id=None),
        },
    )
    save_settings(path, raw)
    loaded = load_settings(path)
    assert loaded.features["result-reranking"].enabled is False
    assert loaded.features["result-reranking"].provider_id is None
