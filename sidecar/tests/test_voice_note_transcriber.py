from __future__ import annotations

import os
from pathlib import Path

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
        repo="Daumee/Qwen3-ASR-0.6B-ONNX-CPU",
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


def _write_fake_onnx_runtime(
    manager: ModelManager,
    *,
    body: str = "hello world",
    language: str = "English",
    speaker_id: str | None = None,
) -> Path:
    checkpoint = manager.commit_dir("audio-transcript", "abc123")
    onnx_dir = checkpoint / "onnx_models"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    (checkpoint / "tokenizer.json").write_text("{}", encoding="utf-8")
    result = {"text": body, "language": language}
    if speaker_id is not None:
        result["speaker_id"] = speaker_id
    script = checkpoint / "onnx_inference.py"
    script.write_text(
        "from pathlib import Path\n"
        "RESULT = " + repr(result) + "\n"
        "load_audio = 'official'\n"
        "class OnnxAsrPipeline:\n"
        "    def __init__(self, onnx_dir, quantize='int8'):\n"
        "        self.onnx_dir = onnx_dir\n"
        "        assert Path(onnx_dir).joinpath('tokenizer.json').exists()\n"
        "        Path(onnx_dir).parent.joinpath('loaded.txt').write_text(str(onnx_dir))\n"
        "        Path(onnx_dir).parent.joinpath('helper.txt').write_text(str(load_audio))\n"
        "    def transcribe(self, audio_path, language=None, **_kwargs):\n"
        "        Path(self.onnx_dir).parent.joinpath('audio.txt').write_text(str(audio_path))\n"
        "        Path(self.onnx_dir).parent.joinpath('kwargs.txt').write_text(repr({'language': language, **_kwargs}))\n"
        "        out = dict(RESULT)\n"
        "        if language is not None:\n"
        "            out['language'] = language\n"
        "        return out\n",
        encoding="utf-8",
    )
    return script


def test_transcription_is_pending_until_asr_model_is_ready(tmp_path: Path):
    manager = _make_manager(tmp_path)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")

    with pytest.raises(TranscriptionPending):
        transcribe_voice_note_audio(manager, audio_path)


def test_transcription_reports_missing_onnx_runtime_script(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")

    with pytest.raises(TranscriptionUnavailable, match="ONNX runtime script"):
        transcribe_voice_note_audio(manager, audio_path)


def test_transcription_uses_activated_local_onnx_checkpoint(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    result = transcribe_voice_note_audio(manager, audio_path)
    checkpoint = (manager.role_dir("audio-transcript") / "current").resolve()

    assert result.transcript == "Speaker 1: hello world"
    assert result.language == "English"
    assert result.speaker_labels == {"speaker_1": "Speaker 1"}
    assert (checkpoint / "loaded.txt").read_text() == str(checkpoint / "onnx_models")
    assert (checkpoint / "helper.txt").read_text() == "official"
    assert (checkpoint / "audio.txt").read_text() == str(audio_path)
    assert (checkpoint / "onnx_models" / "tokenizer.json").exists()
    assert "'max_new_tokens': 1024" in (checkpoint / "kwargs.txt").read_text()
    assert "'chunk_sec': 30" in (checkpoint / "kwargs.txt").read_text()


def test_transcription_accepts_onnx_quality_overrides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    monkeypatch.setenv("COGNIOS_QWEN_ASR_LANGUAGE", "Chinese")
    monkeypatch.setenv("COGNIOS_QWEN_ASR_MAX_NEW_TOKENS", "1536")
    monkeypatch.setenv("COGNIOS_QWEN_ASR_CHUNK_SEC", "20")

    result = transcribe_voice_note_audio(manager, audio_path)
    checkpoint = (manager.role_dir("audio-transcript") / "current").resolve()
    kwargs_text = (checkpoint / "kwargs.txt").read_text()

    assert result.language == "Chinese"
    assert "'language': 'Chinese'" in kwargs_text
    assert "'max_new_tokens': 1536" in kwargs_text
    assert "'chunk_sec': 20" in kwargs_text


def test_transcription_preserves_asr_speaker_hint(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(
        manager,
        body="hello from the second speaker",
        language="English",
        speaker_id="speaker_2",
    )
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    result = transcribe_voice_note_audio(manager, audio_path)

    assert result.transcript == "Speaker 2: hello from the second speaker"
    assert result.language == "English"
    assert result.speaker_labels == {"speaker_2": "Speaker 2"}


def test_transcription_uses_note_local_speaker_tracker_when_asr_has_no_speaker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(
        manager,
        body="follow up from another voice",
        language="English",
    )
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    monkeypatch.setattr(transcriber._SPEAKER_TRACKER, "assign", lambda *_args: "speaker_2")

    result = transcribe_voice_note_audio(manager, audio_path, note_id="note-1")

    assert result.transcript == "Speaker 2: follow up from another voice"
    assert result.speaker_labels == {"speaker_2": "Speaker 2"}


def test_warm_transcriber_loads_model_without_transcribing(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(manager)
    transcriber._MODEL_CACHE.clear()

    transcriber.warm_voice_note_transcriber(manager)
    checkpoint = (manager.role_dir("audio-transcript") / "current").resolve()

    assert (checkpoint / "loaded.txt").read_text() == str(checkpoint / "onnx_models")
    assert not (checkpoint / "audio.txt").exists()
