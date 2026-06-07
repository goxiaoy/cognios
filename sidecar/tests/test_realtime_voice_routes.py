from __future__ import annotations

import socket

from fastapi.testclient import TestClient

from search_sidecar.app import build_app

TOKEN = "0123456789abcdef" * 4


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


def test_realtime_voice_status_reports_supported_runtime_stopped_without_ws(
    monkeypatch, tmp_path
):
    runtime = tmp_path / "realtime-asr"
    runtime.write_text("#!/bin/sh\n", encoding="utf-8")
    runtime.chmod(0o755)
    monkeypatch.setenv("COGNIOS_REALTIME_VOICE_RUNTIME_PATH", str(runtime))
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_WS_URL", raising=False)
    monkeypatch.delenv("COGNIOS_REALTIME_VOICE_ALLOW_EXTERNAL", raising=False)
    app = build_app(token=TOKEN)

    with TestClient(app) as client:
        resp = client.get("/realtime-voice/status", headers=_auth_headers())

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "stopped"
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
