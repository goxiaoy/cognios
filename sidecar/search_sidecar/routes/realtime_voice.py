"""``/realtime-voice/*`` HTTP surface for local realtime ASR capability."""

from __future__ import annotations

from fastapi import APIRouter, Request, WebSocket

from ..realtime_voice import RealtimeVoiceStatus, get_realtime_voice_status
from ..realtime_voice.embedded import (
    ASR_ROLE,
    MODEL as EMBEDDED_MODEL,
    PROVIDER as EMBEDDED_PROVIDER,
    embedded_realtime_voice_available,
    run_embedded_realtime_voice_session,
)

router = APIRouter(prefix="/realtime-voice", tags=["realtime-voice"])


@router.get("/status")
def realtime_voice_status(request: Request) -> dict:
    runtime_status = get_realtime_voice_status()
    if runtime_status.available or runtime_status.runtime_path is not None:
        return runtime_status.to_dict()

    manager = getattr(request.app.state, "model_manager", None)
    embedded_ready, reason = embedded_realtime_voice_available(manager)
    if not embedded_ready:
        if manager is not None and ASR_ROLE in manager.manifest:
            return RealtimeVoiceStatus(
                status="installing",
                available=False,
                local=True,
                provider=EMBEDDED_PROVIDER,
                reason=reason,
                packaging="supported",
                model=EMBEDDED_MODEL,
            ).to_dict()
        return runtime_status.to_dict()

    return RealtimeVoiceStatus(
        status="ready",
        available=True,
        local=True,
        provider=EMBEDDED_PROVIDER,
        reason=reason,
        packaging="supported",
        websocket_url=_embedded_websocket_url(request),
        model=EMBEDDED_MODEL,
    ).to_dict()


@router.websocket("/stream")
async def realtime_voice_stream(websocket: WebSocket) -> None:
    manager = getattr(websocket.app.state, "model_manager", None)
    embedded_ready, _reason = embedded_realtime_voice_available(manager)
    if not embedded_ready:
        await websocket.close(code=1013)
        return
    await run_embedded_realtime_voice_session(websocket, manager)


def _embedded_websocket_url(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    if base.startswith("https://"):
        return f"wss://{base.removeprefix('https://')}/realtime-voice/stream"
    return f"ws://{base.removeprefix('http://')}/realtime-voice/stream"
