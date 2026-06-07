"""GET /healthz returns the Phase-1 stub payload behind bearer auth."""

from __future__ import annotations

from fastapi.testclient import TestClient

from search_sidecar.app import build_app

TOKEN = "0123456789abcdef" * 4


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_healthz_returns_initialising_payload():
    with TestClient(build_app(token=TOKEN)) as client:
        resp = client.get("/healthz", headers=auth_headers())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "initialising"
    assert body["models"] == {}


def test_healthz_payload_shape_is_stable():
    """The shape of /healthz is part of the IPC contract Rust depends
    on (Unit 7). This assertion freezes the keys so a future commit
    cannot silently break the supervisor's state-detection logic."""
    with TestClient(build_app(token=TOKEN)) as client:
        resp = client.get("/healthz", headers=auth_headers())
    body = resp.json()
    assert set(body.keys()) == {"state", "models"}
