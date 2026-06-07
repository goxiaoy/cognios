from __future__ import annotations

import socket
import sys
import time

from fastapi.testclient import TestClient
import pytest

from search_sidecar.app import build_app
from search_sidecar.realtime_voice import stop_realtime_voice_runtime

TOKEN = "0123456789abcdef" * 4


@pytest.fixture(autouse=True)
def _cleanup_realtime_voice_runtime(monkeypatch):
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_RUNTIME_ARGS", raising=False)
    yield
    stop_realtime_voice_runtime()


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_realtime_voice_status_fails_closed_without_packaged_runtime(monkeypatch):
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unavailable"
    assert body["available"] is False
    assert body["local"] is True
    assert body["provider"] == "qwen3-asr-vllm"
    assert body["packaging"] == "missing"
    assert "not packaged" in body["reason"]


def test_realtime_voice_status_fails_closed_for_missing_configured_runtime(
    monkeypatch, tmp_path
):
    missing = tmp_path / "missing-realtime-asr"
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(missing))
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "unavailable"
    assert body["available"] is False
    assert body["packaging"] == "missing"
    assert body["runtime_path"] == str(missing)


def test_realtime_voice_status_fails_closed_for_non_executable_runtime(
    monkeypatch, tmp_path
):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    runtime.chmod(0o644)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["available"] is False
    assert body["packaging"] == "supported"
    assert body["runtime_path"] == str(runtime)


def test_realtime_voice_status_starts_supported_runtime_without_developer_ws(
    monkeypatch, tmp_path
):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\nsleep 30\n", encoding="utf-8")
    runtime.chmod(0o755)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "starting"
    assert body["available"] is False
    assert body["packaging"] == "supported"
    assert body["runtime_path"] == str(runtime)
    assert body["websocket_url"] is None


def test_realtime_voice_status_does_not_trust_developer_ws_url(monkeypatch, tmp_path):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    runtime.chmod(0o755)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_WS_URL", "ws://127.0.0.1:9999/v1/realtime")
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "stopped"
    assert body["available"] is False
    assert body["packaging"] == "supported"
    assert body["websocket_url"] is None


def test_realtime_voice_status_fails_closed_for_unreachable_development_runtime(
    monkeypatch, tmp_path
):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    runtime.chmod(0o755)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_WS_URL", "ws://127.0.0.1:9999/v1/realtime")
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", "1")
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "starting"
    assert body["available"] is False
    assert body["packaging"] == "supported"
    assert body["websocket_url"] is None


def test_realtime_voice_status_allows_reachable_loopback_development_runtime(
    monkeypatch, tmp_path
):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    runtime.chmod(0o755)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.setenv(
        "COGNIOS_REALTIME_VOICE_WS_URL", f"ws://127.0.0.1:{port}/v1/realtime"
    )
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", "1")
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_MODEL", "Qwen/Qwen3-ASR-0.6B")
    app = build_app(token=TOKEN)

    try:
        with TestClient(app) as client:
            resp = client.get("/realtime-voice/status", headers=_auth_headers())
    finally:
        listener.close()

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["available"] is True
    assert body["packaging"] == "supported"
    assert body["websocket_url"] == f"ws://127.0.0.1:{port}/v1/realtime"
    assert body["model"] == "Qwen/Qwen3-ASR-0.6B"


def test_realtime_voice_status_reports_ready_for_managed_packaged_runtime(
    monkeypatch, tmp_path
):
    runtime = _write_fake_runtime(tmp_path / "realtime-asr")
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_MODEL", "mistralai/Voxtral-Mini-4B-Realtime-2602")
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        body = _wait_for_realtime_voice_ready(client)

    assert body["status"] == "ready"
    assert body["available"] is True
    assert body["packaging"] == "supported"
    assert body["runtime_path"] == str(runtime)
    assert body["websocket_url"].startswith("ws://127.0.0.1:")
    assert body["websocket_url"].endswith("/v1/realtime")
    assert body["model"] == "mistralai/Voxtral-Mini-4B-Realtime-2602"


def _wait_for_realtime_voice_ready(client: TestClient) -> dict:
    deadline = time.monotonic() + 5
    last_body: dict | None = None
    while time.monotonic() < deadline:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())
        assert resp.status_code == 200
        last_body = resp.json()
        if last_body["status"] == "ready":
            return last_body
        time.sleep(0.05)
    raise AssertionError(f"managed runtime did not become ready: {last_body}")


def _write_fake_runtime(path):
    path.write_text(
        f"""#!{sys.executable}
import socket
import sys

host = sys.argv[sys.argv.index("--host") + 1]
port = int(sys.argv[sys.argv.index("--port") + 1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind((host, port))
sock.listen(16)
while True:
    conn, _ = sock.accept()
    conn.close()
""",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path
