from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.models.manager import ModelManager
from search_sidecar.models.manifest import FileSpec, ModelSpec
from search_sidecar.voice_notes import transcriber

TOKEN = "0123456789abcdef" * 4


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


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


def _write_fake_onnx_runtime(manager: ModelManager, *, text: str = "meeting started") -> None:
    checkpoint = manager.commit_dir("audio-transcript", "abc123")
    onnx_dir = checkpoint / "onnx_models"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    (checkpoint / "tokenizer.json").write_text("{}", encoding="utf-8")
    (checkpoint / "onnx_inference.py").write_text(
        "from pathlib import Path\n"
        "class OnnxAsrPipeline:\n"
        "    loaded = False\n"
        "    def __init__(self, onnx_dir, quantize='int8'):\n"
        "        self.onnx_dir = onnx_dir\n"
        "        assert Path(onnx_dir).joinpath('tokenizer.json').exists()\n"
        "        Path(onnx_dir).parent.joinpath('loaded.txt').write_text('1')\n"
        "    def transcribe(self, audio_path, language=None, **_kwargs):\n"
        "        Path(self.onnx_dir).parent.joinpath('audio.txt').write_text(str(audio_path))\n"
        f"        return {{'text': {text!r}, 'language': language or 'English'}}\n",
        encoding="utf-8",
    )


def test_transcribe_route_returns_pending_when_model_is_not_ready(tmp_path: Path):
    manager = _make_manager(tmp_path)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    app = build_app(token=TOKEN, model_manager=manager)

    with TestClient(app) as client:
        resp = client.post(
            "/voice-notes/transcribe",
            json={"note_id": "note-1", "audio_path": str(audio_path)},
            headers=_auth_headers(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["error"] == "Qwen ASR model is not ready"


def test_warm_transcriber_route_loads_asr_model(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(manager)
    transcriber._MODEL_CACHE.clear()
    app = build_app(token=TOKEN, model_manager=manager)

    with TestClient(app) as client:
        resp = client.post(
            "/voice-notes/warm-transcriber",
            json={},
            headers=_auth_headers(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["error"] is None
    checkpoint = (manager.role_dir("audio-transcript") / "current").resolve()
    assert (checkpoint / "loaded.txt").read_text() == "1"
    assert not (checkpoint / "audio.txt").exists()


def test_transcribe_route_returns_completed_transcript(tmp_path: Path):
    manager = _make_manager(tmp_path)
    _activate(manager)
    _write_fake_onnx_runtime(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()
    app = build_app(token=TOKEN, model_manager=manager)

    with TestClient(app) as client:
        resp = client.post(
            "/voice-notes/transcribe",
            json={"note_id": "note-1", "audio_path": str(audio_path)},
            headers=_auth_headers(),
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert body["transcript"] == "Speaker 1: meeting started"
    assert body["language"] == "English"
    assert body["speaker_labels"] == {"speaker_1": "Speaker 1"}
    checkpoint = (manager.role_dir("audio-transcript") / "current").resolve()
    assert (checkpoint / "audio.txt").read_text() == str(audio_path)
    assert (checkpoint / "onnx_models" / "tokenizer.json").exists()
