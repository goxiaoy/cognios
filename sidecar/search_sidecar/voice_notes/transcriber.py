"""Qwen ASR-backed voice-note transcription.

The sidecar owns model storage, so this module loads Qwen3-ASR from the
ModelManager's activated local checkpoint instead of letting qwen-asr
download a second copy into a package-specific cache.
"""

from __future__ import annotations

import importlib
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..models.manager import ModelManager

ASR_ROLE = "audio-transcript"

_MODEL_CACHE: dict[str, Any] = {}
_MODEL_CACHE_LOCK = threading.Lock()
_TRANSCRIBE_LOCK = threading.Lock()


class TranscriptionPending(RuntimeError):
    """Raised when the ASR model files are not activated yet."""


class TranscriptionUnavailable(RuntimeError):
    """Raised when the local ASR runtime is not installed/configured."""


@dataclass(frozen=True)
class VoiceNoteTranscription:
    transcript: str
    language: str | None = None
    speaker_labels: dict[str, str] = field(
        default_factory=lambda: {"speaker_1": "Speaker 1"}
    )


def transcribe_voice_note_audio(
    manager: ModelManager,
    audio_path: Path,
    *,
    language: str | None = None,
) -> VoiceNoteTranscription:
    """Transcribe one saved voice-note source file.

    Qwen3-ASR handles language identification internally when
    ``language`` is ``None``. Speaker diarization is not part of this
    first pass; callers still receive a stable ``speaker_1`` label so
    the transcript metadata shape is ready for a diarization backend.
    """
    if not audio_path.exists():
        raise FileNotFoundError(f"voice note audio file not found: {audio_path}")
    if audio_path.stat().st_size == 0:
        raise ValueError("voice note audio file is empty")

    checkpoint = _activated_checkpoint(manager, ASR_ROLE)
    qwen_asr = _import_qwen_asr()
    model = _load_qwen_asr_model(qwen_asr, checkpoint)
    with _TRANSCRIBE_LOCK:
        raw_result = _run_transcription(model, audio_path, language=language)
    text, detected_language = _extract_text_and_language(raw_result)
    text = text.strip()
    if not text:
        raise ValueError("Qwen ASR returned an empty transcript")

    return VoiceNoteTranscription(
        transcript=_ensure_speaker_prefix(text),
        language=detected_language,
    )


def _activated_checkpoint(manager: ModelManager, role: str) -> Path:
    if role not in manager.manifest:
        raise TranscriptionUnavailable(f"ASR model role {role!r} is not configured")
    if not manager.is_ready(role):
        raise TranscriptionPending("Qwen ASR model is not ready")

    current = manager.role_dir(role) / "current"
    try:
        return current.resolve(strict=True)
    except OSError as err:
        raise TranscriptionPending("Qwen ASR model checkpoint is not activated") from err


def _import_qwen_asr() -> Any:
    try:
        return importlib.import_module("qwen_asr")
    except ModuleNotFoundError as err:
        if err.name != "qwen_asr":
            raise TranscriptionUnavailable(
                f"qwen-asr dependency is missing: {err.name}"
            ) from err
        raise TranscriptionUnavailable(
            "qwen-asr Python package is not installed in the sidecar runtime"
        ) from err


def _load_qwen_asr_model(qwen_asr: Any, checkpoint: Path) -> Any:
    cache_key = str(checkpoint)
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(cache_key)
        if cached is not None:
            return cached

        model_cls = getattr(qwen_asr, "Qwen3ASRModel", None)
        if model_cls is None:
            raise TranscriptionUnavailable(
                "qwen_asr.Qwen3ASRModel is unavailable in the installed package"
            )

        model = _from_pretrained(model_cls, checkpoint)
        _MODEL_CACHE[cache_key] = model
        return model


def _from_pretrained(model_cls: Any, checkpoint: Path) -> Any:
    load_kwargs = _load_kwargs()
    if hasattr(model_cls, "from_pretrained"):
        try:
            return model_cls.from_pretrained(str(checkpoint), **load_kwargs)
        except TypeError:
            if load_kwargs:
                return model_cls.from_pretrained(str(checkpoint))
            raise
    return model_cls(str(checkpoint))


def _load_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "max_new_tokens": 1024,
    }
    try:
        torch = importlib.import_module("torch")
    except ModuleNotFoundError:
        return kwargs

    cuda = getattr(torch, "cuda", None)
    if cuda is not None and callable(getattr(cuda, "is_available", None)):
        if cuda.is_available():
            kwargs["dtype"] = torch.bfloat16
            kwargs["device_map"] = "cuda:0"
    return kwargs


def _run_transcription(
    model: Any,
    audio_path: Path,
    *,
    language: str | None,
) -> Any:
    try:
        return model.transcribe(audio=str(audio_path), language=language)
    except TypeError:
        return model.transcribe(str(audio_path))


def _extract_text_and_language(raw_result: Any) -> tuple[str, str | None]:
    result = raw_result[0] if isinstance(raw_result, (list, tuple)) else raw_result
    if isinstance(result, str):
        return result, None
    if isinstance(result, dict):
        return (
            str(
                result.get("text")
                or result.get("transcript")
                or result.get("transcription")
                or ""
            ),
            _maybe_str(result.get("language")),
        )
    return (
        str(
            getattr(result, "text", None)
            or getattr(result, "transcript", None)
            or getattr(result, "transcription", None)
            or ""
        ),
        _maybe_str(getattr(result, "language", None)),
    )


def _maybe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _ensure_speaker_prefix(text: str) -> str:
    first_line = text.splitlines()[0].lstrip()
    if first_line.startswith("[") or first_line.lower().startswith("speaker "):
        return text
    return f"Speaker 1: {text}"
