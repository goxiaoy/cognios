"""``/realtime-voice/*`` HTTP surface for local realtime ASR capability."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request

from ..realtime_voice import get_realtime_voice_status
from ..settings import load_settings

router = APIRouter(prefix="/realtime-voice", tags=["realtime-voice"])


@router.get("/status")
def realtime_voice_status(request: Request) -> dict:
    settings_path = getattr(request.app.state, "settings_path", None)
    settings = load_settings(Path(settings_path)) if settings_path is not None else None
    return get_realtime_voice_status(settings).to_dict()
