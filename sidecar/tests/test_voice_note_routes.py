from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

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


def test_transcribe_route_returns_completed_transcript(
    tmp_path: Path, monkeypatch
):
    manager = _make_manager(tmp_path)
    _activate(manager)
    audio_path = tmp_path / "source.webm"
    audio_path.write_bytes(b"audio")
    transcriber._MODEL_CACHE.clear()

    class FakeQwen3ASRModel:
        @classmethod
        def from_pretrained(cls, _checkpoint: str, **_kwargs):
            return cls()

        def transcribe(self, *, audio: str, language: str | None = None):
            assert audio == str(audio_path)
            return [{"text": "meeting started", "language": "English"}]

    monkeypatch.setitem(
        sys.modules,
        "qwen_asr",
        SimpleNamespace(Qwen3ASRModel=FakeQwen3ASRModel),
    )
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
