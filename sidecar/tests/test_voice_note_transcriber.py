from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from search_sidecar.models.manager import ModelManager
from search_sidecar.models.manifest import FileSpec, ModelSpec
from search_sidecar.voice_notes import transcriber
from search_sidecar.voice_notes.transcriber import (
    TranscriptionPending,
    TranscriptionUnavailable,
    transcribe_voice_note_audio,
)


def _make_manager(tmp_path: Path) -> ModelManager:
    spec = ModelSpec(
        role="audio-transcript",
        repo="Qwen/Qwen3-ASR-0.6B",
        commit="abc123",
        files=(FileSpec("config.json", "0" * 64),),
    )
    return ModelManager(storage_dir=tmp_path, manifest={"audio-transcript": spec})


def _activate(manager: ModelManager) -> None:
    commit_dir = manager.commit_dir("audio-transcript", "abc123")
    commit_dir.mkdir(parents=True, exist_ok=True)
    current = manager.role_dir("audio-transcript") / "current"
    if current.exists() or current.is_symlink():
        current.unlink()
    os.symlink("abc123", current)


def test_transcription_is_pending_until_asr_model_is_ready(tmp_path: Path):
    manager = _make_manager(tmp_path)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")

    with pytest.raises(TranscriptionPending):
        transcribe_voice_note_audio(manager, audio_path)


def test_transcription_reports_missing_qwen_asr_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manager = _make_manager(tmp_path)
    _activate(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    real_import_module = transcriber.importlib.import_module

    def missing_qwen_asr(name: str):
        if name == "qwen_asr":
            raise ModuleNotFoundError(name=name)
        return real_import_module(name)

    monkeypatch.setattr(transcriber.importlib, "import_module", missing_qwen_asr)

    with pytest.raises(TranscriptionUnavailable):
        transcribe_voice_note_audio(manager, audio_path)


def test_transcription_uses_activated_local_qwen_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manager = _make_manager(tmp_path)
    _activate(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    class FakeQwen3ASRModel:
        loaded_checkpoint: str | None = None
        transcribed_audio: str | None = None

        @classmethod
        def from_pretrained(cls, checkpoint: str, **_kwargs):
            cls.loaded_checkpoint = checkpoint
            return cls()

        def transcribe(self, *, audio: str, language: str | None = None):
            self.__class__.transcribed_audio = audio
            assert language is None
            return [SimpleNamespace(text="hello world", language="English")]

    monkeypatch.setitem(
        sys.modules,
        "qwen_asr",
        SimpleNamespace(Qwen3ASRModel=FakeQwen3ASRModel),
    )

    result = transcribe_voice_note_audio(manager, audio_path)

    assert result.transcript == "Speaker 1: hello world"
    assert result.language == "English"
    assert result.speaker_labels == {"speaker_1": "Speaker 1"}
    assert FakeQwen3ASRModel.loaded_checkpoint == str(
        (manager.role_dir("audio-transcript") / "current").resolve()
    )
    assert FakeQwen3ASRModel.transcribed_audio == str(audio_path)
