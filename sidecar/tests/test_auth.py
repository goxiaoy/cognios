"""Bearer-token middleware behaviour."""

from __future__ import annotations

import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.auth import BearerAuthMiddleware, generate_token

VALID_TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")


def test_generate_token_is_64_lowercase_hex():
    token = generate_token()
    assert VALID_TOKEN_RE.match(token), f"unexpected token format: {token!r}"


def test_generate_token_uniqueness():
    a = generate_token()
    b = generate_token()
    assert a != b


def test_request_without_authorization_returns_401():
    app = build_app(token="0" * 64)
    with TestClient(app) as client:
        resp = client.get("/healthz")
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "missing_authorization"


def test_request_with_wrong_token_returns_401():
    app = build_app(token="a" * 64)
    with TestClient(app) as client:
        resp = client.get("/healthz", headers={"Authorization": "Bearer b" * 33})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "invalid_token"


def test_request_with_non_bearer_scheme_returns_401():
    app = build_app(token="a" * 64)
    with TestClient(app) as client:
        resp = client.get("/healthz", headers={"Authorization": "Basic abc123"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "missing_authorization"


def test_request_with_correct_token_succeeds():
    token = "deadbeef" * 8  # 64 hex chars
    app = build_app(token=token)
    with TestClient(app) as client:
        resp = client.get("/healthz", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text


def test_middleware_rejects_subtle_token_mismatch():
    """The middleware must use constant-time comparison so a one-char
    difference is rejected as firmly as a fully wrong token."""
    correct = "a" * 64
    almost = "a" * 63 + "b"
    app = build_app(token=correct)
    with TestClient(app) as client:
        resp = client.get("/healthz", headers={"Authorization": f"Bearer {almost}"})
    assert resp.status_code == 401
