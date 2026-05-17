"""``/voice-notes/*`` HTTP surface for saved source audio."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..models.manager import ModelManager
from ..voice_notes.transcriber import (
    TranscriptionPending,
    TranscriptionUnavailable,
    transcribe_voice_note_audio,
    warm_voice_note_transcriber,
)

router = APIRouter(prefix="/voice-notes", tags=["voice-notes"])


class VoiceNoteTranscribePayload(BaseModel):
    note_id: str
    audio_path: str
    language: str | None = None


class VoiceNoteTranscribeResponse(BaseModel):
    status: Literal["pending", "completed", "unavailable", "failed"]
    transcript: str | None = None
    language: str | None = None
    speaker_labels: dict[str, str] = Field(default_factory=dict)
    error: str | None = None


class VoiceNoteWarmTranscriberResponse(BaseModel):
    status: Literal["ready", "pending", "unavailable", "failed"]
    error: str | None = None


def _get_manager(request: Request) -> ModelManager:
    manager = getattr(request.app.state, "model_manager", None)
    if manager is None:
        raise HTTPException(
            status_code=500,
            detail="model_manager not configured on app.state",
        )
    return manager


@router.post("/warm-transcriber")
def warm_transcriber(request: Request) -> dict:
    manager = _get_manager(request)
    started_at = time.perf_counter()
    ok = False
    try:
        try:
            warm_voice_note_transcriber(manager)
        except TranscriptionPending as err:
            return VoiceNoteWarmTranscriberResponse(
                status="pending",
                error=str(err),
            ).model_dump()
        except TranscriptionUnavailable as err:
            return VoiceNoteWarmTranscriberResponse(
                status="unavailable",
                error=str(err),
            ).model_dump()
        except Exception as err:
            return VoiceNoteWarmTranscriberResponse(
                status="failed",
                error=str(err),
            ).model_dump()

        ok = True
        return VoiceNoteWarmTranscriberResponse(status="ready").model_dump()
    finally:
        store = getattr(request.app.state, "observability_store", None)
        if store is not None:
            store.record_duration(
                "voice_note_transcription_warmup",
                int((time.perf_counter() - started_at) * 1000),
                ok=ok,
            )


@router.post("/transcribe")
def transcribe_voice_note(
    body: VoiceNoteTranscribePayload,
    request: Request,
) -> dict:
    manager = _get_manager(request)
    started_at = time.perf_counter()
    ok = False
    try:
        try:
            result = transcribe_voice_note_audio(
                manager,
                Path(body.audio_path),
                language=body.language,
                note_id=body.note_id,
            )
        except TranscriptionPending as err:
            return VoiceNoteTranscribeResponse(
                status="pending",
                error=str(err),
            ).model_dump()
        except TranscriptionUnavailable as err:
            return VoiceNoteTranscribeResponse(
                status="unavailable",
                error=str(err),
            ).model_dump()
        except Exception as err:
            return VoiceNoteTranscribeResponse(
                status="failed",
                error=str(err),
            ).model_dump()

        ok = True
        return VoiceNoteTranscribeResponse(
            status="completed",
            transcript=result.transcript,
            language=result.language,
            speaker_labels=result.speaker_labels,
        ).model_dump()
    finally:
        store = getattr(request.app.state, "observability_store", None)
        if store is not None:
            store.record_duration(
                "voice_note_transcription",
                int((time.perf_counter() - started_at) * 1000),
                ok=ok,
            )
