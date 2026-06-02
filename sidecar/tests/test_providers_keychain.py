"""Tests for the provider secret env-file wrapper."""

from __future__ import annotations

from pathlib import Path

import pytest

from search_sidecar.providers import keychain
from search_sidecar.providers.keychain import (
    SECRET_ENV_FILE_OVERRIDE,
    SecretStoreUnavailableError,
    delete_provider_secret,
    get_provider_secret,
    has_provider_secret,
)


@pytest.fixture
def secret_env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / ".env"
    monkeypatch.setenv(SECRET_ENV_FILE_OVERRIDE, str(path))
    keychain.invalidate_provider_secret_cache()
    return path


def test_get_returns_none_when_no_entry(secret_env_file: Path):
    assert get_provider_secret("openai") is None


def test_get_round_trips_value(secret_env_file: Path):
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-xxx\n")
    assert get_provider_secret("openai") == "sk-xxx"


def test_get_strips_trailing_whitespace(secret_env_file: Path):
    secret_env_file.write_text('COGNIOS_PROVIDER_OPENAI_KEY="sk-xxx\\n  "\n')
    assert get_provider_secret("openai") == "sk-xxx"


def test_get_returns_none_for_whitespace_only_value(secret_env_file: Path):
    secret_env_file.write_text('COGNIOS_PROVIDER_X_KEY="   \\n"\n')
    assert get_provider_secret("x") is None


def test_provider_namespace_isolated_from_unrelated_keys(secret_env_file: Path):
    secret_env_file.write_text(
        "HF_TOKEN=hf_real_token\n"
        "COGNIOS_PROVIDER_HF_TOKEN_KEY=different_value\n"
    )
    assert get_provider_secret("hf-token") == "different_value"


def test_has_provider_secret_returns_true_when_present(secret_env_file: Path):
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=k\n")
    assert has_provider_secret("openai") is True


def test_has_provider_secret_returns_false_when_missing(secret_env_file: Path):
    assert has_provider_secret("openai") is False


def test_has_provider_secret_returns_false_on_store_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        keychain,
        "_parse_env_file",
        lambda _path: (_ for _ in ()).throw(
            SecretStoreUnavailableError("read failed")
        ),
    )
    assert has_provider_secret("openai") is False


def test_delete_removes_entry(secret_env_file: Path):
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=k\n")
    delete_provider_secret("openai")
    assert get_provider_secret("openai") is None
    assert secret_env_file.read_text() == ""


def test_delete_is_idempotent(secret_env_file: Path):
    delete_provider_secret("never-existed")


def test_empty_provider_id_rejected():
    with pytest.raises(ValueError, match="provider_id must not be empty"):
        get_provider_secret("")


def test_env_file_unavailable_raises_clear_error(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(SECRET_ENV_FILE_OVERRIDE, "/dev/null/not-a-file")
    with pytest.raises(SecretStoreUnavailableError):
        get_provider_secret("openai")


def test_env_override_bypasses_env_file(
    secret_env_file: Path, monkeypatch: pytest.MonkeyPatch
):
    keychain.invalidate_provider_secret_cache()
    monkeypatch.setenv("COGNIOS_PROVIDER_OPENAI_KEY", "sk-from-env")
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-from-file\n")
    assert get_provider_secret("openai") == "sk-from-env"


def test_env_override_handles_hyphenated_provider_ids(
    monkeypatch: pytest.MonkeyPatch,
):
    keychain.invalidate_provider_secret_cache()
    monkeypatch.setenv("COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY", "sk-qwen")
    assert get_provider_secret("qwen-dashscope") == "sk-qwen"


def test_env_override_empty_value_falls_through_to_env_file(
    secret_env_file: Path, monkeypatch: pytest.MonkeyPatch
):
    keychain.invalidate_provider_secret_cache()
    monkeypatch.setenv("COGNIOS_PROVIDER_OPENAI_KEY", "   ")
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-real\n")
    assert get_provider_secret("openai") == "sk-real"


def test_cache_serves_subsequent_reads_from_memory(secret_env_file: Path):
    keychain.invalidate_provider_secret_cache()
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-original\n")
    assert get_provider_secret("openai") == "sk-original"

    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-rotated\n")
    assert get_provider_secret("openai") == "sk-original"


def test_invalidate_provider_secret_cache_drops_specific_entry(
    secret_env_file: Path,
):
    keychain.invalidate_provider_secret_cache()
    secret_env_file.write_text(
        "COGNIOS_PROVIDER_OPENAI_KEY=sk-a\n"
        "COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=sk-b\n"
    )
    assert get_provider_secret("openai") == "sk-a"
    assert get_provider_secret("qwen-dashscope") == "sk-b"

    secret_env_file.write_text(
        "COGNIOS_PROVIDER_OPENAI_KEY=sk-rotated\n"
        "COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=sk-c\n"
    )
    keychain.invalidate_provider_secret_cache("openai")
    assert get_provider_secret("openai") == "sk-rotated"
    assert get_provider_secret("qwen-dashscope") == "sk-b"


def test_invalidate_all_clears_every_entry(secret_env_file: Path):
    keychain.invalidate_provider_secret_cache()
    secret_env_file.write_text(
        "COGNIOS_PROVIDER_OPENAI_KEY=sk-a\n"
        "COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=sk-b\n"
    )
    get_provider_secret("openai")
    get_provider_secret("qwen-dashscope")

    secret_env_file.write_text(
        "COGNIOS_PROVIDER_OPENAI_KEY=sk-a2\n"
        "COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=sk-b2\n"
    )
    keychain.invalidate_provider_secret_cache()
    assert get_provider_secret("openai") == "sk-a2"
    assert get_provider_secret("qwen-dashscope") == "sk-b2"


def test_delete_provider_secret_invalidates_cache(secret_env_file: Path):
    keychain.invalidate_provider_secret_cache()
    secret_env_file.write_text("COGNIOS_PROVIDER_OPENAI_KEY=sk-original\n")
    assert get_provider_secret("openai") == "sk-original"
    delete_provider_secret("openai")
    assert get_provider_secret("openai") is None
