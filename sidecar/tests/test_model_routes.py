"""``/models/*`` HTTP routes via FastAPI TestClient."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.models.manager import ModelManager
from search_sidecar.models.manifest import FileSpec, ModelSpec

TOKEN = "0123456789abcdef" * 4


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def _make_manager(tmp_path: Path) -> ModelManager:
    spec = ModelSpec(
        role="embedding",
        repo="fixture/repo",
        commit="abc123",
        files=(FileSpec("a.bin", "0" * 64),),
    )
    captioner = ModelSpec(
        role="captioner",
        repo="fixture/repo",
        commit="def456",
        files=(FileSpec("b.gguf", "0" * 64),),
        license="gemma",
        requires_acceptance=True,
    )
    return ModelManager(
        storage_dir=tmp_path,
        manifest={"embedding": spec, "captioner": captioner},
    )


def test_status_returns_initial_state(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.get("/models/status", headers=_auth_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert "roles" in body
    assert body["roles"]["embedding"]["state"] == "missing"
    assert body["roles"]["embedding"]["requires_acceptance"] is False
    assert body["roles"]["captioner"]["requires_acceptance"] is True
    assert body["roles"]["captioner"]["license_accepted"] is False


def test_status_requires_bearer_auth(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.get("/models/status")
    assert resp.status_code == 401


def test_accept_license_sets_flag(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.post(
            "/models/accept-license/captioner", headers=_auth_headers()
        )
        assert resp.status_code == 200
        assert resp.json() == {"accepted": True, "role": "captioner"}

        status = client.get("/models/status", headers=_auth_headers()).json()
        assert status["roles"]["captioner"]["license_accepted"] is True


def test_accept_license_unknown_role_returns_404(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.post(
            "/models/accept-license/nonexistent", headers=_auth_headers()
        )
    assert resp.status_code == 404


def test_download_for_captioner_without_license_returns_409(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.post(
            "/models/download/captioner", json={}, headers=_auth_headers()
        )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "license_not_accepted"


def test_download_unknown_role_returns_404(tmp_path: Path):
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.post(
            "/models/download/nonexistent", json={}, headers=_auth_headers()
        )
    assert resp.status_code == 404


def test_healthz_includes_model_states_when_manager_attached(tmp_path: Path):
    """Phase 2 amendment to the /healthz contract: when a ModelManager
    is mounted, /healthz surfaces per-role state alongside the global
    initialising flag."""
    manager = _make_manager(tmp_path)
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        resp = client.get("/healthz", headers=_auth_headers())
    body = resp.json()
    assert body["state"] == "initialising"
    assert body["models"] == {"embedding": "missing", "captioner": "missing"}


def test_download_emits_sse_error_when_url_unreachable(tmp_path: Path):
    """The download endpoint always returns 200 + SSE; transport
    failures are reported inside the stream as state=error events."""
    spec = ModelSpec(
        role="embedding",
        repo="fixture/repo",
        commit="abc123",
        files=(FileSpec("a.bin", "0" * 64),),
    )
    manager = ModelManager(
        storage_dir=tmp_path,
        manifest={"embedding": spec},
        # Point at a definitely-unreachable URL.
        url_override={
            "fixture/repo@abc123/a.bin": "http://127.0.0.1:1/never_listening"
        },
    )
    app = build_app(token=TOKEN, model_manager=manager)
    with TestClient(app) as client:
        with client.stream(
            "POST",
            "/models/download/embedding",
            json={},
            headers=_auth_headers(),
        ) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            events = []
            for line in resp.iter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[len("data: ") :]))

    assert events, "expected at least one SSE event"
    assert events[-1]["state"] == "error"
