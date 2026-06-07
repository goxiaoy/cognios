"""Lifecycle startup hooks."""

from __future__ import annotations

from search_sidecar.lifecycle import (
    advanced_ocr_autorun_enabled,
    prepare_extract_dir,
    prepare_search_dir,
    prepare_settings_path,
)


def test_advanced_ocr_autorun_env_defaults_enabled(monkeypatch):
    monkeypatch.delenv("COGNIOS_ADVANCED_OCR_AUTORUN", raising=False)
    assert advanced_ocr_autorun_enabled() is True


def test_advanced_ocr_autorun_env_can_disable(monkeypatch):
    for value in ("0", "false", "no", "off"):
        monkeypatch.setenv("COGNIOS_ADVANCED_OCR_AUTORUN", value)
        assert advanced_ocr_autorun_enabled() is False


def test_prepare_extract_dir_uses_storage_root_sibling(tmp_path):
    extract_dir = prepare_extract_dir(tmp_path)

    assert extract_dir == tmp_path / "extract"
    assert extract_dir.is_dir()
    assert not (tmp_path / "search" / "extract").exists()


def test_prepare_settings_path_uses_storage_root(tmp_path):
    search_dir = prepare_search_dir(tmp_path)

    settings_path = prepare_settings_path(tmp_path, search_dir)

    assert settings_path == tmp_path / "settings.json"


def test_prepare_settings_path_migrates_legacy_search_file(tmp_path):
    search_dir = prepare_search_dir(tmp_path)
    legacy_path = search_dir / "settings.json"
    legacy_path.write_text('{"version": 1}')

    settings_path = prepare_settings_path(tmp_path, search_dir)

    assert settings_path == tmp_path / "settings.json"
    assert settings_path.read_text() == '{"version": 1}'
    assert not legacy_path.exists()
