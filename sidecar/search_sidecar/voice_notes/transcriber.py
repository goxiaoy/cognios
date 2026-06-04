"""Qwen ASR ONNX-backed voice-note transcription.

The sidecar owns model storage, so this module loads Qwen3-ASR from the
ModelManager's activated local ONNX checkpoint instead of letting a Python
package download a second copy into a package-specific cache.
"""

from __future__ import annotations

import importlib
import importlib.util
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..models.manager import ModelManager

ASR_ROLE = "audio-transcript"

_MODEL_CACHE: dict[str, Any] = {}
_MODEL_CACHE_LOCK = threading.Lock()
_TRANSCRIBE_LOCK = threading.Lock()
_SPEAKER_MATCH_THRESHOLD = 0.86
_MAX_SPEAKERS_PER_NOTE = 8
_SPEAKER_PREFIX_RE = re.compile(
    r"^(?:\[[^\]]+\]\s*)?Speaker\s+(\d+)\s*:",
    re.IGNORECASE,
)


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


@dataclass
class _SpeakerProfile:
    speaker_id: str
    centroid: Any
    samples: int = 1


class _SpeakerTracker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._profiles_by_note: dict[str, list[_SpeakerProfile]] = {}
        self._pending_initial_profiles: set[str] = set()

    def assign(self, note_id: str, audio_path: Path) -> str:
        with self._lock:
            profiles = list(self._profiles_by_note.setdefault(note_id, []))
            if not profiles:
                self._start_initial_profile(note_id, audio_path)
                return "speaker_1"

        embedding = _audio_embedding(audio_path)
        if embedding is None:
            return "speaker_1"

        with self._lock:
            profiles = self._profiles_by_note.setdefault(note_id, [])
            if not profiles:
                profiles.append(_SpeakerProfile("speaker_1", embedding))
                return "speaker_1"

            best_profile = max(
                profiles,
                key=lambda profile: _cosine_similarity(profile.centroid, embedding),
            )
            best_score = _cosine_similarity(best_profile.centroid, embedding)
            if best_score >= _SPEAKER_MATCH_THRESHOLD:
                best_profile.centroid = (
                    best_profile.centroid * best_profile.samples + embedding
                ) / (best_profile.samples + 1)
                best_profile.samples += 1
                return best_profile.speaker_id

            if len(profiles) >= _MAX_SPEAKERS_PER_NOTE:
                return best_profile.speaker_id

            speaker_id = f"speaker_{len(profiles) + 1}"
            profiles.append(_SpeakerProfile(speaker_id, embedding))
            return speaker_id

    def _start_initial_profile(self, note_id: str, audio_path: Path) -> None:
        if note_id in self._pending_initial_profiles:
            return
        self._pending_initial_profiles.add(note_id)
        worker = threading.Thread(
            target=self._record_initial_profile,
            args=(note_id, audio_path),
            daemon=True,
        )
        worker.start()

    def _record_initial_profile(self, note_id: str, audio_path: Path) -> None:
        try:
            embedding = _audio_embedding(audio_path)
            if embedding is None:
                return
            with self._lock:
                profiles = self._profiles_by_note.setdefault(note_id, [])
                if not profiles:
                    profiles.append(_SpeakerProfile("speaker_1", embedding))
        finally:
            with self._lock:
                self._pending_initial_profiles.discard(note_id)

    def clear(self) -> None:
        with self._lock:
            self._profiles_by_note.clear()
            self._pending_initial_profiles.clear()


_SPEAKER_TRACKER = _SpeakerTracker()


def transcribe_voice_note_audio(
    manager: ModelManager,
    audio_path: Path,
    *,
    language: str | None = None,
    note_id: str | None = None,
) -> VoiceNoteTranscription:
    """Transcribe one saved voice-note source file.

    Qwen3-ASR ONNX handles language identification internally when
    ``language`` is ``None``. If the ASR runtime returns speaker hints, they are preserved.
    Otherwise realtime chunks are assigned note-local speaker labels from a
    lightweight audio embedding so short utterances keep stable labels without
    blocking on a dedicated diarization model.
    """
    if not audio_path.exists():
        raise FileNotFoundError(f"voice note audio file not found: {audio_path}")
    if audio_path.stat().st_size == 0:
        raise ValueError("voice note audio file is empty")

    checkpoint = _activated_checkpoint(manager, ASR_ROLE)
    model = _load_onnx_asr_pipeline(checkpoint)
    with _TRANSCRIBE_LOCK:
        raw_result = _run_transcription(model, audio_path, language=language)
    text, detected_language, speaker_id = _extract_transcription_parts(raw_result)
    text = text.strip()
    if not text:
        raise ValueError("Qwen ASR returned an empty transcript")
    speaker_labels = _speaker_labels_from_transcript(text)
    if not speaker_labels:
        if speaker_id is None and note_id:
            speaker_id = _SPEAKER_TRACKER.assign(note_id, audio_path)
        speaker_id = speaker_id or "speaker_1"
        text = _ensure_speaker_prefix(text, speaker_id)
        speaker_labels = {speaker_id: _speaker_label(speaker_id)}

    return VoiceNoteTranscription(
        transcript=text,
        language=detected_language,
        speaker_labels=speaker_labels,
    )


def warm_voice_note_transcriber(manager: ModelManager) -> None:
    """Load the ASR runtime and activated checkpoint before first audio arrives."""
    checkpoint = _activated_checkpoint(manager, ASR_ROLE)
    _load_onnx_asr_pipeline(checkpoint)


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


def _load_onnx_asr_pipeline(checkpoint: Path) -> Any:
    cache_key = str(checkpoint)
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(cache_key)
        if cached is not None:
            return cached

        module = _load_onnx_inference_module(checkpoint)
        pipeline_cls = getattr(module, "OnnxAsrPipeline", None)
        if pipeline_cls is None:
            raise TranscriptionUnavailable(
                "onnx_inference.py does not expose OnnxAsrPipeline"
            )
        onnx_dir = checkpoint / "onnx_models"
        if not onnx_dir.exists():
            raise TranscriptionUnavailable(
                "Qwen ASR ONNX model files are missing from the activated checkpoint"
            )
        try:
            model = pipeline_cls(onnx_dir=str(onnx_dir), quantize="int8")
        except TypeError:
            model = pipeline_cls(str(onnx_dir))
        _MODEL_CACHE[cache_key] = model
        return model


def _load_onnx_inference_module(checkpoint: Path) -> Any:
    script = checkpoint / "onnx_inference.py"
    if not script.exists():
        raise TranscriptionUnavailable(
            "Qwen ASR ONNX runtime script is missing from the activated checkpoint"
        )
    module_name = f"_cognios_qwen_asr_onnx_{abs(hash(str(checkpoint)))}"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, script)
    if spec is None or spec.loader is None:
        raise TranscriptionUnavailable(
            "Qwen ASR ONNX runtime script could not be loaded"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except ModuleNotFoundError as err:
        sys.modules.pop(module_name, None)
        raise TranscriptionUnavailable(
            f"Qwen ASR ONNX runtime dependency is missing: {err.name}"
        ) from err
    return module


def _run_transcription(
    model: Any,
    audio_path: Path,
    *,
    language: str | None,
) -> Any:
    try:
        return model.transcribe(audio=str(audio_path), language=language)
    except TypeError:
        try:
            return model.transcribe(str(audio_path), language=language)
        except TypeError:
            return model.transcribe(str(audio_path))


def _extract_transcription_parts(raw_result: Any) -> tuple[str, str | None, str | None]:
    if isinstance(raw_result, (list, tuple)):
        lines: list[str] = []
        detected_language: str | None = None
        speaker_ids: list[str] = []
        for item in raw_result:
            text, language, speaker_id = _extract_single_result(item)
            text = text.strip()
            if language and detected_language is None:
                detected_language = language
            if not text:
                continue
            if speaker_id:
                speaker_ids.append(speaker_id)
                if not _has_speaker_prefix(text):
                    text = _ensure_speaker_prefix(text, speaker_id)
            lines.append(text)
        if lines:
            unique_speakers = set(speaker_ids)
            speaker_id = speaker_ids[0] if len(unique_speakers) == 1 else None
            return "\n".join(lines), detected_language, speaker_id
        return "", detected_language, None

    return _extract_single_result(raw_result)


def _extract_single_result(result: Any) -> tuple[str, str | None, str | None]:
    if isinstance(result, str):
        return result, None, None
    if isinstance(result, dict):
        return (
            str(
                result.get("text")
                or result.get("transcript")
                or result.get("transcription")
                or ""
            ),
            _maybe_str(result.get("language")),
            _speaker_id_from_hint(_first_mapping_value(result, _SPEAKER_KEYS)),
        )
    return (
        str(
            getattr(result, "text", None)
            or getattr(result, "transcript", None)
            or getattr(result, "transcription", None)
            or ""
        ),
        _maybe_str(getattr(result, "language", None)),
        _speaker_id_from_hint(_first_attr_value(result, _SPEAKER_KEYS)),
    )


_SPEAKER_KEYS = (
    "speaker",
    "speaker_id",
    "speakerId",
    "speaker_label",
    "speakerLabel",
    "speaker_index",
    "speakerIndex",
    "speaker_number",
    "speakerNumber",
)


def _first_mapping_value(mapping: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _first_attr_value(value: Any, keys: tuple[str, ...]) -> Any:
    for key in keys:
        attr = getattr(value, key, None)
        if attr is not None:
            return attr
    return None


def _maybe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _ensure_speaker_prefix(text: str, speaker_id: str = "speaker_1") -> str:
    first_line = text.splitlines()[0].lstrip()
    if _has_speaker_prefix(first_line):
        return text
    return f"{_speaker_label(speaker_id)}: {text}"


def _has_speaker_prefix(text: str) -> bool:
    return _SPEAKER_PREFIX_RE.match(text.lstrip()) is not None


def _speaker_labels_from_transcript(text: str) -> dict[str, str]:
    labels: dict[str, str] = {}
    for line in text.splitlines():
        match = _SPEAKER_PREFIX_RE.match(line.lstrip())
        if not match:
            continue
        speaker_id = f"speaker_{int(match.group(1))}"
        labels[speaker_id] = _speaker_label(speaker_id)
    return labels


def _speaker_id_from_hint(value: Any) -> str | None:
    text = _maybe_str(value)
    if text is None:
        return None
    speaker_match = re.fullmatch(r"speaker[_\s-]*(\d+)", text, re.IGNORECASE)
    if speaker_match:
        raw_number = speaker_match.group(1)
        number = int(raw_number)
        if raw_number.startswith("0"):
            number += 1
        return f"speaker_{max(number, 1)}"

    number_match = re.search(r"\d+", text)
    if number_match:
        return f"speaker_{max(int(number_match.group(0)), 1)}"

    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    if not slug:
        return None
    return f"speaker_{slug}"


def _speaker_label(speaker_id: str) -> str:
    match = re.fullmatch(r"speaker_(\d+)", speaker_id, re.IGNORECASE)
    if match:
        return f"Speaker {int(match.group(1))}"
    suffix = speaker_id.removeprefix("speaker_").replace("_", " ").strip()
    return f"Speaker {suffix.title()}" if suffix else "Speaker 1"


def _audio_embedding(audio_path: Path) -> Any | None:
    try:
        librosa = importlib.import_module("librosa")
        numpy = importlib.import_module("numpy")
    except ModuleNotFoundError:
        return None

    try:
        waveform, sample_rate = librosa.load(str(audio_path), sr=16000, mono=True)
        if waveform.size == 0:
            return None
        waveform, _ = librosa.effects.trim(waveform, top_db=30)
        if waveform.size < sample_rate * 0.25:
            return None
        mfcc = librosa.feature.mfcc(y=waveform, sr=sample_rate, n_mfcc=13)
        vector = numpy.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)])
        norm = numpy.linalg.norm(vector)
        if not numpy.isfinite(norm) or norm <= 0:
            return None
        return vector / norm
    except Exception:
        return None


def _cosine_similarity(left: Any, right: Any) -> float:
    try:
        return float(left.dot(right))
    except Exception:
        return 0.0
