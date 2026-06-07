"""Local realtime voice runtime detection.

This module is intentionally conservative. A local realtime ASR runtime can
only report ready after packaging has a managed runtime path to probe. A
developer WebSocket URL alone is not enough for product readiness because it
would depend on a manually launched server outside the CogniOS bundle.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

Status = Literal[
    "unavailable",
    "installing",
    "starting",
    "ready",
    "degraded",
    "failed",
    "stopped",
]

_TRUE_VALUES = {"1", "true", "yes", "on"}
_RUNTIME_PATH_ENV = "COGNIOS_REALTIME_VOICE_RUNTIME_PATH"
_WS_URL_ENV = "COGNIOS_REALTIME_VOICE_WS_URL"
_ALLOW_EXTERNAL_ENV = "COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL"


@dataclass(frozen=True)
class RealtimeVoiceStatus:
    status: Status
    available: bool
    local: bool
    provider: str
    reason: str
    packaging: str
    runtime_path: str | None = None
    websocket_url: str | None = None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "available": self.available,
            "local": self.local,
            "provider": self.provider,
            "reason": self.reason,
            "packaging": self.packaging,
            "runtime_path": self.runtime_path,
            "websocket_url": self.websocket_url,
        }


def get_realtime_voice_status() -> RealtimeVoiceStatus:
    runtime_path = _runtime_path()
    websocket_url = _websocket_url()

    if runtime_path is None:
        return RealtimeVoiceStatus(
            status="unavailable",
            available=False,
            local=True,
            provider="qwen3-asr-vllm",
            reason="Local realtime ASR runtime is not packaged with this build.",
            packaging="missing",
            websocket_url=websocket_url,
        )

    if not runtime_path.exists():
        return RealtimeVoiceStatus(
            status="unavailable",
            available=False,
            local=True,
            provider="qwen3-asr-vllm",
            reason="Configured local realtime ASR runtime path does not exist.",
            packaging="missing",
            runtime_path=str(runtime_path),
            websocket_url=websocket_url,
        )

    if not os.access(runtime_path, os.X_OK):
        return RealtimeVoiceStatus(
            status="failed",
            available=False,
            local=True,
            provider="qwen3-asr-vllm",
            reason="Configured local realtime ASR runtime is not executable.",
            packaging="supported",
            runtime_path=str(runtime_path),
            websocket_url=websocket_url,
        )

    if websocket_url:
        if not _allow_external_runtime():
            return RealtimeVoiceStatus(
                status="stopped",
                available=False,
                local=True,
                provider="qwen3-asr-vllm",
                reason="Packaged runtime exists, but no managed realtime ASR session is running.",
                packaging="supported",
                runtime_path=str(runtime_path),
            )
        if not _is_loopback_websocket_url(websocket_url):
            return RealtimeVoiceStatus(
                status="failed",
                available=False,
                local=True,
                provider="qwen3-asr-vllm",
                reason="Realtime ASR development WebSocket must be a loopback endpoint.",
                packaging="supported",
                runtime_path=str(runtime_path),
            )
        if not _websocket_endpoint_is_reachable(websocket_url):
            return RealtimeVoiceStatus(
                status="starting",
                available=False,
                local=True,
                provider="qwen3-asr-vllm",
                reason="Realtime ASR development WebSocket is not reachable yet.",
                packaging="supported",
                runtime_path=str(runtime_path),
            )
        return RealtimeVoiceStatus(
            status="ready",
            available=True,
            local=True,
            provider="qwen3-asr-vllm",
            reason="Development realtime ASR runtime is explicitly enabled.",
            packaging="supported",
            runtime_path=str(runtime_path),
            websocket_url=websocket_url,
        )

    return RealtimeVoiceStatus(
        status="stopped",
        available=False,
        local=True,
        provider="qwen3-asr-vllm",
        reason="Packaged runtime exists, but realtime ASR startup is not wired yet.",
        packaging="supported",
        runtime_path=str(runtime_path),
    )


def _runtime_path() -> Path | None:
    value = os.getenv(_RUNTIME_PATH_ENV, "").strip()
    if not value:
        return None
    return Path(value).expanduser()


def _websocket_url() -> str | None:
    value = os.getenv(_WS_URL_ENV, "").strip()
    if not value:
        return None
    if value.startswith(("ws://", "wss://")):
        return value
    return None


def _allow_external_runtime() -> bool:
    return os.getenv(_ALLOW_EXTERNAL_ENV, "").strip().lower() in _TRUE_VALUES


def _is_loopback_websocket_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "ws" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}


def _websocket_endpoint_is_reachable(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.hostname is None:
        return False
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    try:
        with socket.create_connection((parsed.hostname, port), timeout=0.25):
            return True
    except OSError:
        return False
