"""Embedded realtime ASR WebSocket backed by the local Qwen ONNX model."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import uuid
import wave
from pathlib import Path
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

from ..models.manager import ModelManager
from ..voice_notes.transcriber import (
    ASR_ROLE,
    TranscriptionPending,
    TranscriptionUnavailable,
    transcribe_voice_note_audio,
)

SAMPLE_RATE = 16_000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
DEFAULT_WINDOW_MS = 2_000
MIN_WINDOW_MS = 800
WINDOW_MS_ENV = "COGNIOS_REALTIME_VOICE_ONNX_WINDOW_MS"
PROVIDER = "qwen3-asr-onnx-realtime"
MODEL = "Qwen3-ASR-0.6B-ONNX-CPU"


def embedded_realtime_voice_available(manager: ModelManager | None) -> tuple[bool, str]:
    if manager is None:
        return False, "model manager is not configured"
    if ASR_ROLE not in manager.manifest:
        return False, "local Qwen ASR model role is not configured"
    if not manager.is_ready(ASR_ROLE):
        return False, "local Qwen ASR model is not downloaded yet"
    return True, "Embedded local Qwen ASR realtime runtime is ready."


async def run_embedded_realtime_voice_session(
    websocket: WebSocket,
    manager: ModelManager,
) -> None:
    await websocket.accept()
    session_id = str(uuid.uuid4())
    await websocket.send_text(
        json.dumps(
            {
                "type": "session.created",
                "id": session_id,
                "model": MODEL,
            }
        )
    )

    transcriber = _WindowedRealtimeTranscriber(manager=manager, session_id=session_id)
    try:
        while True:
            message = await websocket.receive_text()
            event = _parse_json_event(message)
            if event is None:
                continue
            event_type = event.get("type")
            if event_type == "input_audio_buffer.append":
                for transcript in await transcriber.append_audio(event.get("audio")):
                    await _send_transcript(websocket, transcript)
            elif event_type == "input_audio_buffer.commit":
                if event.get("final") is True:
                    for transcript in await transcriber.flush():
                        await _send_transcript(websocket, transcript)
                    return
            elif event_type == "session.update":
                continue
    except WebSocketDisconnect:
        return
    except Exception as err:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "error",
                    "message": str(err),
                }
            )
        )


class _WindowedRealtimeTranscriber:
    def __init__(self, *, manager: ModelManager, session_id: str) -> None:
        self.manager = manager
        self.session_id = session_id
        self.buffer = bytearray()
        self.window_bytes = _window_bytes()

    async def append_audio(self, encoded_audio: Any) -> list[str]:
        if not isinstance(encoded_audio, str) or not encoded_audio:
            return []
        try:
            self.buffer.extend(base64.b64decode(encoded_audio, validate=True))
        except ValueError:
            return []

        transcripts: list[str] = []
        while len(self.buffer) >= self.window_bytes:
            chunk = bytes(self.buffer[: self.window_bytes])
            del self.buffer[: self.window_bytes]
            transcript = await asyncio.to_thread(self._transcribe_pcm16, chunk)
            if transcript:
                transcripts.append(transcript)
        return transcripts

    async def flush(self) -> list[str]:
        if len(self.buffer) < _min_window_bytes():
            self.buffer.clear()
            return []
        chunk = bytes(self.buffer)
        self.buffer.clear()
        transcript = await asyncio.to_thread(self._transcribe_pcm16, chunk)
        return [transcript] if transcript else []

    def _transcribe_pcm16(self, audio: bytes) -> str | None:
        if not audio:
            return None
        with tempfile.TemporaryDirectory(prefix="cognios-realtime-asr-") as tmpdir:
            wav_path = Path(tmpdir) / "chunk.wav"
            _write_pcm16_wav(wav_path, audio)
            try:
                result = transcribe_voice_note_audio(
                    self.manager,
                    wav_path,
                    note_id=self.session_id,
                )
            except (TranscriptionPending, TranscriptionUnavailable):
                raise
            text = result.transcript.strip()
            return text or None


async def _send_transcript(websocket: WebSocket, transcript: str) -> None:
    await websocket.send_text(
        json.dumps(
            {
                "type": "transcription.delta",
                "delta": transcript,
            }
        )
    )
    await websocket.send_text(
        json.dumps(
            {
                "type": "transcription.done",
                "text": transcript,
            }
        )
    )


def _parse_json_event(raw: str) -> dict[str, Any] | None:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _write_pcm16_wav(path: Path, audio: bytes) -> None:
    if len(audio) % SAMPLE_WIDTH_BYTES:
        audio = audio[:-1]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(CHANNELS)
        wav.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(audio)


def _window_bytes() -> int:
    window_ms = _positive_int_env(WINDOW_MS_ENV, DEFAULT_WINDOW_MS)
    window_ms = max(window_ms, MIN_WINDOW_MS)
    return int(SAMPLE_RATE * SAMPLE_WIDTH_BYTES * window_ms / 1000)


def _min_window_bytes() -> int:
    return int(SAMPLE_RATE * SAMPLE_WIDTH_BYTES * MIN_WINDOW_MS / 1000)


def _positive_int_env(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, "").strip())
    except ValueError:
        return fallback
    return value if value > 0 else fallback
