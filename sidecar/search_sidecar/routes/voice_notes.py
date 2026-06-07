"""``/voice-notes/*`` HTTP surface for saved source audio."""

from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..chat.types import ChatProviderError

router = APIRouter(prefix="/voice-notes", tags=["voice-notes"])


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
