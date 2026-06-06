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
from ..chat.types import ChatProviderError

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


class VoiceNoteSummarizePayload(BaseModel):
    note_id: str
    transcript: str
    model: str | None = None


class VoiceNoteSummarizeResponse(BaseModel):
    status: Literal["completed", "unavailable", "failed"]
    summary: str | None = None
    action_items: list[str] = Field(default_factory=list)
    provider: dict | None = None
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


@router.post("/summarize")
def summarize_voice_note(
    body: VoiceNoteSummarizePayload,
    request: Request,
) -> dict:
    orchestrator = getattr(request.app.state, "chat_orchestrator", None)
    if orchestrator is None:
        return VoiceNoteSummarizeResponse(
            status="unavailable",
            error="LLM provider unavailable",
        ).model_dump()

    started_at = time.perf_counter()
    ok = False
    try:
        try:
            result = orchestrator.summarize_voice_note(
                body.transcript,
                model=body.model,
            )
        except ChatProviderError as err:
            return VoiceNoteSummarizeResponse(
                status="failed",
                error=str(err),
            ).model_dump()
        except Exception as err:
            return VoiceNoteSummarizeResponse(
                status="failed",
                error=str(err),
            ).model_dump()

        if result is None:
            return VoiceNoteSummarizeResponse(
                status="unavailable",
                error="LLM provider unavailable",
            ).model_dump()

        ok = True
        provider = {
            "providerId": result.provider_id,
            "model": result.model,
            "usage": result.usage,
        }
        _record_provider_usage(request, provider)
        return VoiceNoteSummarizeResponse(
            status="completed",
            summary=result.summary,
            action_items=result.action_items,
            provider=provider,
        ).model_dump()
    finally:
        store = getattr(request.app.state, "observability_store", None)
        if store is not None:
            store.record_duration(
                "voice_note_summary",
                int((time.perf_counter() - started_at) * 1000),
                ok=ok,
            )


def _record_provider_usage(request: Request, provider: dict | None) -> None:
    if not provider:
        return
    store = getattr(request.app.state, "observability_store", None)
    if store is None:
        return
    store.record_usage(
        provider_id=provider.get("providerId") or provider.get("provider_id"),
        model=provider.get("model"),
        usage=provider.get("usage"),
    )
