"""Local realtime voice runtime detection and startup.

The product path is a managed loopback vLLM process: the sidecar receives the
packaged executable path, starts it on an OS-assigned localhost port, and only
reports ready after that port accepts connections. A developer WebSocket URL is
still available for local testing, but it must be explicitly allowed.
"""

from __future__ import annotations

import os
import shlex
import socket
import subprocess
import threading
import time
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
_MODEL_ENV = "COGNIOS_REALTIME_VOICE_MODEL"
_RUNTIME_ARGS_ENV = "COGNIOS_REALTIME_VOICE_RUNTIME_ARGS"
_HOST = "127.0.0.1"
_DEFAULT_MODEL = "mistralai/Voxtral-Mini-4B-Realtime-2602"
_DEFAULT_RUNTIME_ARGS = "serve {model} --host {host} --port {port} --enforce-eager"

_MANAGED_LOCK = threading.Lock()
_MANAGED_RUNTIME: "_ManagedRealtimeVoiceRuntime | None" = None


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
    model: str | None = None

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
            "model": self.model,
        }


def get_realtime_voice_status() -> RealtimeVoiceStatus:
    runtime_path = _runtime_path()
    websocket_url = _websocket_url()
    model = _model()

    if runtime_path is None:
        return RealtimeVoiceStatus(
            status="unavailable",
            available=False,
            local=True,
            provider="qwen3-asr-vllm",
            reason="Local realtime ASR runtime is not packaged with this build.",
            packaging="missing",
            websocket_url=websocket_url,
            model=model,
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
            model=model,
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
            model=model,
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
                model=model,
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
                model=model,
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
                model=model,
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
            model=model,
        )

    return _managed_runtime_status(runtime_path, model)


def warm_realtime_voice_runtime() -> None:
    """Best-effort background warmup for packaged realtime ASR.

    This intentionally reuses the status path so all fail-closed checks stay in
    one place. Any process startup failure is reflected by later status calls.
    """
    get_realtime_voice_status()


def stop_realtime_voice_runtime() -> None:
    global _MANAGED_RUNTIME
    with _MANAGED_LOCK:
        if _MANAGED_RUNTIME is not None:
            _MANAGED_RUNTIME.stop()
            _MANAGED_RUNTIME = None


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


def _model() -> str | None:
    value = os.getenv(_MODEL_ENV, "").strip()
    return value or _DEFAULT_MODEL


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


def _managed_runtime_status(runtime_path: Path, model: str | None) -> RealtimeVoiceStatus:
    global _MANAGED_RUNTIME
    args_template = _runtime_args_template()
    key = (str(runtime_path), model or "", args_template)

    with _MANAGED_LOCK:
        if _MANAGED_RUNTIME is None or _MANAGED_RUNTIME.key != key:
            if _MANAGED_RUNTIME is not None:
                _MANAGED_RUNTIME.stop()
            _MANAGED_RUNTIME = _ManagedRealtimeVoiceRuntime(
                runtime_path=runtime_path,
                model=model or _DEFAULT_MODEL,
                args_template=args_template,
                key=key,
            )
        runtime = _MANAGED_RUNTIME
        runtime.start()
        snapshot = runtime.snapshot()

    return RealtimeVoiceStatus(
        status=snapshot.status,
        available=snapshot.status == "ready",
        local=True,
        provider="qwen3-asr-vllm",
        reason=snapshot.reason,
        packaging="supported",
        runtime_path=str(runtime_path),
        websocket_url=snapshot.websocket_url if snapshot.status == "ready" else None,
        model=model,
    )


def _runtime_args_template() -> str:
    return os.getenv(_RUNTIME_ARGS_ENV, "").strip() or _DEFAULT_RUNTIME_ARGS


@dataclass(frozen=True)
class _ManagedRuntimeSnapshot:
    status: Literal["starting", "ready", "failed"]
    reason: str
    websocket_url: str | None


class _ManagedRealtimeVoiceRuntime:
    def __init__(
        self,
        *,
        runtime_path: Path,
        model: str,
        args_template: str,
        key: tuple[str, str, str],
    ) -> None:
        self.runtime_path = runtime_path
        self.model = model
        self.args_template = args_template
        self.key = key
        self.process: subprocess.Popen[bytes] | None = None
        self.port: int | None = None
        self.websocket_url: str | None = None
        self.started_at: float | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        self.port = _choose_loopback_port()
        self.websocket_url = f"ws://{_HOST}:{self.port}/v1/realtime"
        try:
            args = _runtime_args(
                self.args_template,
                model=self.model,
                host=_HOST,
                port=self.port,
            )
            self.process = subprocess.Popen(
                [str(self.runtime_path), *args],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            self.started_at = time.monotonic()
            self.last_error = None
        except (OSError, ValueError, KeyError) as err:
            self.process = None
            self.last_error = str(err)

    def snapshot(self) -> _ManagedRuntimeSnapshot:
        if self.last_error is not None:
            return _ManagedRuntimeSnapshot(
                status="failed",
                reason=f"Managed realtime ASR runtime failed to start: {self.last_error}",
                websocket_url=None,
            )
        if self.process is None or self.websocket_url is None:
            return _ManagedRuntimeSnapshot(
                status="failed",
                reason="Managed realtime ASR runtime did not start.",
                websocket_url=None,
            )
        exit_code = self.process.poll()
        if exit_code is not None:
            return _ManagedRuntimeSnapshot(
                status="failed",
                reason=f"Managed realtime ASR runtime exited with code {exit_code}.",
                websocket_url=None,
            )
        if _websocket_endpoint_is_reachable(self.websocket_url):
            return _ManagedRuntimeSnapshot(
                status="ready",
                reason="Managed realtime ASR runtime is running locally.",
                websocket_url=self.websocket_url,
            )
        return _ManagedRuntimeSnapshot(
            status="starting",
            reason="Managed realtime ASR runtime is starting.",
            websocket_url=None,
        )

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5.0)


def _runtime_args(
    template: str,
    *,
    model: str,
    host: str,
    port: int,
) -> list[str]:
    rendered = template.format(model=model, host=host, port=port)
    return shlex.split(rendered)


def _choose_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((_HOST, 0))
        return int(sock.getsockname()[1])
