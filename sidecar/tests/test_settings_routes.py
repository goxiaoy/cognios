"""``/settings`` HTTP routes — round-trip + auth + validation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.settings import (
    CURRENT_VERSION,
    default_settings,
    load_settings,
    save_settings,
)

TOKEN = "0123456789abcdef" * 4


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def app_and_path(tmp_path: Path):
    settings_path = tmp_path / "settings.json"
    app = build_app(token=TOKEN, settings_path=settings_path)
    return app, settings_path


def test_get_settings_returns_defaults_when_file_missing(app_and_path):
    app, _ = app_and_path
    with TestClient(app) as client:
        resp = client.get("/settings", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"] == CURRENT_VERSION
    assert body["features"]["semantic-search"]["enabled"] is True
    assert body["features"]["semantic-search"]["provider_id"] == "local-gte"
    assert body["providers"]["local-gte"]["enabled"] is True
    assert body["needs_restart"] is False


def test_get_settings_returns_persisted_values(app_and_path):
    app, settings_path = app_and_path
    s = default_settings()
    s.cloud_consent_acked = ["openai"]
    save_settings(settings_path, s)
    with TestClient(app) as client:
        resp = client.get("/settings", headers=_auth())
    assert resp.json()["cloud_consent_acked"] == ["openai"]


def test_put_settings_persists_and_round_trips(app_and_path):
    app, settings_path = app_and_path
    payload = default_settings().model_dump(mode="json")
    payload["features"]["result-reranking"]["enabled"] = True
    payload["features"]["result-reranking"]["provider_id"] = "local-gte-reranker"
    payload["providers"]["local-gte-reranker"] = {
        "provider_id": "local-gte-reranker",
        "enabled": True,
        "api_key_ref": None,
        "base_url": None,
        "model_per_capability": {},
    }
    with TestClient(app) as client:
        resp = client.put("/settings", json=payload, headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["features"]["result-reranking"]["enabled"] is True
    # File was actually written.
    on_disk = load_settings(settings_path)
    assert on_disk.features["result-reranking"].provider_id == "local-gte-reranker"


def test_put_settings_validates_shape_returns_422_on_bad_payload(app_and_path):
    app, _ = app_and_path
    bad = {"version": 1, "providers": "not a dict", "features": {}}
    with TestClient(app) as client:
        resp = client.put("/settings", json=bad, headers=_auth())
    assert resp.status_code == 422
    # Standard FastAPI/Pydantic validation error shape.
    assert "detail" in resp.json()


def test_get_settings_requires_bearer_auth(app_and_path):
    app, _ = app_and_path
    with TestClient(app) as client:
        resp = client.get("/settings")
    assert resp.status_code == 401


def test_put_settings_requires_bearer_auth(app_and_path):
    app, _ = app_and_path
    with TestClient(app) as client:
        resp = client.put("/settings", json={})
    assert resp.status_code == 401


def test_settings_route_500_when_path_not_configured():
    """If a sidecar mounts the settings router without setting
    ``app.state.settings_path``, the route returns a 500 with a clear
    diagnostic rather than a confusing AttributeError."""
    app = build_app(token=TOKEN)  # no settings_path
    with TestClient(app) as client:
        resp = client.get("/settings", headers=_auth())
    assert resp.status_code == 500
    assert "settings_path" in resp.json()["detail"]


def test_put_settings_partial_payload_replaces_full_state(app_and_path):
    """``PUT`` is full replacement, not merge — Pydantic validates the
    whole document. A payload missing ``providers`` validates against
    the default factory (empty dict)."""
    app, settings_path = app_and_path
    save_settings(settings_path, default_settings())
    payload = {
        "version": CURRENT_VERSION,
        # Note: providers omitted entirely.
        "features": {
            "semantic-search": {"enabled": True, "provider_id": None},
        },
        "cloud_consent_acked": [],
        "first_run_skipped": False,
    }
    with TestClient(app) as client:
        resp = client.put("/settings", json=payload, headers=_auth())
    assert resp.status_code == 200
    on_disk = load_settings(settings_path)
    # default factory yielded an empty providers dict — semantic-search
    # is now bound to None, not local-gte. Caller's responsibility to
    # supply the full state.
    assert on_disk.providers == {}
    assert on_disk.features["semantic-search"].provider_id is None


def test_put_then_get_consistency(app_and_path):
    """The state visible via GET immediately after PUT matches what
    was written — round-trip via the load() inside the route returns
    the persisted shape."""
    app, _ = app_and_path
    payload = default_settings().model_dump(mode="json")
    payload["first_run_skipped"] = True
    with TestClient(app) as client:
        put_resp = client.put("/settings", json=payload, headers=_auth())
        get_resp = client.get("/settings", headers=_auth())
    # PUT and GET return the same body shape.
    put_body = put_resp.json()
    get_body = get_resp.json()
    assert put_body == get_body
    assert get_body["first_run_skipped"] is True
