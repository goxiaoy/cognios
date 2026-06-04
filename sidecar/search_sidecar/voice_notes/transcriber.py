"""Qwen ASR ONNX-backed voice-note transcription.

The sidecar owns model storage, so this module loads Qwen3-ASR from the
ModelManager's activated local ONNX checkpoint instead of letting a Python
package download a second copy into a package-specific cache.
"""

from __future__ import annotations

import importlib
import importlib.util
import re
import shutil
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
        _patch_onnx_runtime_audio_helpers(module)
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
        _ensure_onnx_runtime_layout(checkpoint, onnx_dir)
        try:
            model = pipeline_cls(onnx_dir=str(onnx_dir), quantize="int8")
        except TypeError:
            model = pipeline_cls(str(onnx_dir))
        _MODEL_CACHE[cache_key] = model
        return model


def _ensure_onnx_runtime_layout(checkpoint: Path, onnx_dir: Path) -> None:
    """Make downloaded root-level files visible where the ONNX script expects them."""
    source = checkpoint / "tokenizer.json"
    target = onnx_dir / "tokenizer.json"
    if target.exists():
        return
    if not source.exists():
        raise TranscriptionUnavailable(
            "Qwen ASR tokenizer.json is missing from the activated checkpoint"
        )
    try:
        target.symlink_to(Path("..") / source.name)
    except FileExistsError:
        return
    except OSError:
        try:
            shutil.copy2(source, target)
        except OSError as err:
            raise TranscriptionUnavailable(
                "Qwen ASR tokenizer.json could not be linked into onnx_models"
            ) from err


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


def _patch_onnx_runtime_audio_helpers(module: Any) -> None:
    module.load_audio = _onnx_load_audio
    module.compute_mel_spectrogram = _onnx_compute_mel_spectrogram
    module.get_mel_filters = _onnx_get_mel_filters
    module.find_silence_split_points = _onnx_find_silence_split_points


def _onnx_load_audio(path: str) -> Any:
    numpy = importlib.import_module("numpy")
    soundfile = importlib.import_module("soundfile")
    waveform, sample_rate = soundfile.read(path, dtype="float32", always_2d=False)
    waveform = numpy.asarray(waveform, dtype=numpy.float32)
    if waveform.ndim == 2:
        waveform = waveform.mean(axis=1)
    if sample_rate != 16000 and waveform.size:
        duration = waveform.size / float(sample_rate)
        target_size = max(1, int(round(duration * 16000)))
        source_x = numpy.linspace(0.0, duration, num=waveform.size, endpoint=False)
        target_x = numpy.linspace(0.0, duration, num=target_size, endpoint=False)
        waveform = numpy.interp(target_x, source_x, waveform).astype(numpy.float32)
    return waveform.astype(numpy.float32, copy=False)


def _onnx_compute_mel_spectrogram(wav: Any, mel_filters: Any) -> Any:
    numpy = importlib.import_module("numpy")
    n_fft = 400
    hop_length = 160
    waveform = numpy.asarray(wav, dtype=numpy.float32)
    if waveform.size == 0:
        waveform = numpy.zeros(1, dtype=numpy.float32)
    pad_mode = "reflect" if waveform.size > 1 else "constant"
    padded = numpy.pad(waveform, (n_fft // 2, n_fft // 2), mode=pad_mode)
    frame_count = max(1, 1 + (padded.size - n_fft) // hop_length)
    strides = (padded.strides[0] * hop_length, padded.strides[0])
    frames = numpy.lib.stride_tricks.as_strided(
        padded,
        shape=(frame_count, n_fft),
        strides=strides,
        writeable=False,
    )
    window = _periodic_hann(numpy, n_fft)
    spectrum = numpy.fft.rfft(frames * window[None, :], n=n_fft, axis=1)
    magnitudes = numpy.abs(spectrum).T ** 2
    mel_spec = mel_filters @ magnitudes
    log_spec = numpy.log10(numpy.maximum(mel_spec, 1e-10))
    log_spec = numpy.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0).astype(numpy.float32)


def _onnx_get_mel_filters() -> Any:
    numpy = importlib.import_module("numpy")
    sample_rate = 16000
    n_fft = 400
    n_mels = 128
    min_mel = _hz_to_mel(numpy, 0.0)
    max_mel = _hz_to_mel(numpy, sample_rate / 2)
    mel_points = numpy.linspace(min_mel, max_mel, n_mels + 2)
    hz_points = _mel_to_hz(numpy, mel_points)
    fft_freqs = numpy.linspace(0.0, sample_rate / 2, n_fft // 2 + 1)
    fdiff = numpy.diff(hz_points)
    ramps = hz_points[:, None] - fft_freqs[None, :]
    weights = numpy.maximum(
        0.0,
        numpy.minimum(
            -ramps[:-2] / fdiff[:-1, None],
            ramps[2:] / fdiff[1:, None],
        ),
    )
    weights *= (2.0 / (hz_points[2 : n_mels + 2] - hz_points[:n_mels]))[:, None]
    return weights.astype(numpy.float32)


def _onnx_find_silence_split_points(wav: Any, target_sec: int = 30) -> list[int]:
    numpy = importlib.import_module("numpy")
    sample_rate = 16000
    min_sec = target_sec // 2
    max_sec = int(target_sec * 1.5)
    waveform = numpy.asarray(wav, dtype=numpy.float32)
    total_samples = waveform.size
    if total_samples <= max_sec * sample_rate:
        return []

    hop_samples = int(0.1 * sample_rate)
    frame_length = hop_samples * 2
    frame_count = max(1, 1 + max(0, total_samples - frame_length) // hop_samples)
    rms_values = []
    for index in range(frame_count):
        start = index * hop_samples
        frame = waveform[start : start + frame_length]
        if frame.size == 0:
            rms_values.append(0.0)
        else:
            rms_values.append(float(numpy.sqrt(numpy.mean(frame * frame))))
    rms = numpy.asarray(rms_values, dtype=numpy.float32)
    ref = float(rms.max()) if rms.size else 0.0
    if ref <= 0:
        return []
    rms_db = 20.0 * numpy.log10(numpy.maximum(rms, 1e-10) / ref)
    is_silent = rms_db < -40

    split_points: list[int] = []
    cursor = 0
    while cursor + max_sec * sample_rate < total_samples:
        search_start_sec = max(0, cursor / sample_rate + min_sec)
        search_end_sec = cursor / sample_rate + max_sec
        target_abs_sec = cursor / sample_rate + target_sec
        frame_start = int(search_start_sec / 0.1)
        frame_end = min(int(search_end_sec / 0.1), len(is_silent))
        frame_target = int(target_abs_sec / 0.1)
        silent_frames = numpy.where(is_silent[frame_start:frame_end])[0] + frame_start
        if len(silent_frames) > 0:
            best_idx = int(numpy.argmin(numpy.abs(silent_frames - frame_target)))
            split_sample = int(silent_frames[best_idx] * hop_samples)
        else:
            split_sample = int(target_abs_sec * sample_rate)
        split_sample = min(split_sample, total_samples)
        split_points.append(split_sample)
        cursor = split_sample
    return split_points


def _periodic_hann(numpy: Any, size: int) -> Any:
    return (0.5 - 0.5 * numpy.cos(2.0 * numpy.pi * numpy.arange(size) / size)).astype(
        numpy.float32
    )


def _hz_to_mel(numpy: Any, frequencies: Any) -> Any:
    scalar = numpy.isscalar(frequencies)
    frequencies = numpy.atleast_1d(numpy.asarray(frequencies, dtype=numpy.float64))
    f_sp = 200.0 / 3
    mels = frequencies / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = numpy.log(6.4) / 27
    log_region = frequencies >= min_log_hz
    mels = mels.astype(numpy.float64, copy=True)
    mels[log_region] = (
        min_log_mel + numpy.log(frequencies[log_region] / min_log_hz) / logstep
    )
    return float(mels[0]) if scalar else mels


def _mel_to_hz(numpy: Any, mels: Any) -> Any:
    scalar = numpy.isscalar(mels)
    mels = numpy.atleast_1d(numpy.asarray(mels, dtype=numpy.float64))
    f_sp = 200.0 / 3
    freqs = mels * f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = numpy.log(6.4) / 27
    log_region = mels >= min_log_mel
    freqs = freqs.astype(numpy.float64, copy=True)
    freqs[log_region] = min_log_hz * numpy.exp(
        logstep * (mels[log_region] - min_log_mel)
    )
    return float(freqs[0]) if scalar else freqs


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
        numpy = importlib.import_module("numpy")
        waveform = _onnx_load_audio(str(audio_path))
        if waveform.size == 0:
            return None
        waveform = _trim_silence(numpy, waveform, top_db=30)
        sample_rate = 16000
        if waveform.size < sample_rate * 0.25:
            return None
        vector = _speaker_feature_vector(numpy, waveform)
        norm = numpy.linalg.norm(vector)
        if not numpy.isfinite(norm) or norm <= 0:
            return None
        return vector / norm
    except Exception:
        return None


def _trim_silence(numpy: Any, waveform: Any, *, top_db: float) -> Any:
    peak = float(numpy.max(numpy.abs(waveform))) if waveform.size else 0.0
    if peak <= 0:
        return waveform
    threshold = peak * (10.0 ** (-top_db / 20.0))
    non_silent = numpy.where(numpy.abs(waveform) >= threshold)[0]
    if non_silent.size == 0:
        return waveform
    return waveform[int(non_silent[0]) : int(non_silent[-1]) + 1]


def _speaker_feature_vector(numpy: Any, waveform: Any) -> Any:
    waveform = numpy.asarray(waveform, dtype=numpy.float32)
    frame_length = 400
    hop_length = 160
    if waveform.size < frame_length:
        waveform = numpy.pad(waveform, (0, frame_length - waveform.size))
    frame_count = max(1, 1 + (waveform.size - frame_length) // hop_length)
    strides = (waveform.strides[0] * hop_length, waveform.strides[0])
    frames = numpy.lib.stride_tricks.as_strided(
        waveform,
        shape=(frame_count, frame_length),
        strides=strides,
        writeable=False,
    )
    window = _periodic_hann(numpy, frame_length)
    spectrum = numpy.abs(numpy.fft.rfft(frames * window[None, :], axis=1))
    band_edges = numpy.linspace(0, spectrum.shape[1], 14, dtype=int)
    band_energy = []
    for start, end in zip(band_edges[:-1], band_edges[1:]):
        end = max(start + 1, end)
        band_energy.append(numpy.log1p(spectrum[:, start:end].mean(axis=1)))
    bands = numpy.asarray(band_energy, dtype=numpy.float32)
    rms = numpy.sqrt(numpy.mean(frames * frames, axis=1))
    zero_crossing = numpy.mean(frames[:, 1:] * frames[:, :-1] < 0, axis=1)
    return numpy.concatenate(
        [
            bands.mean(axis=1),
            bands.std(axis=1),
            numpy.asarray(
                [
                    waveform.mean(),
                    waveform.std(),
                    rms.mean(),
                    rms.std(),
                    zero_crossing.mean(),
                    zero_crossing.std(),
                ],
                dtype=numpy.float32,
            ),
        ]
    ).astype(numpy.float32)


def _cosine_similarity(left: Any, right: Any) -> float:
    try:
        return float(left.dot(right))
    except Exception:
        return 0.0
