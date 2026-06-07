"""``/realtime-voice/*`` HTTP surface for local realtime ASR capability."""

from __future__ import annotations

from fastapi import APIRouter

from ..realtime_voice import get_realtime_voice_status

router = APIRouter(prefix="/realtime-voice", tags=["realtime-voice"])


@router.get("/status")
def realtime_voice_status() -> dict:
    return get_realtime_voice_status().to_dict()
