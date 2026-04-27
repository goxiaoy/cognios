"""POST /search route — TestClient against the real orchestrator."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.text import TextProcessor
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.retrieval import SearchOrchestrator
from search_sidecar.storage import open_store

TOKEN = "0" * 64
UUID_A = "11111111-1111-1111-1111-111111111111"


def _make_job(path: Path, *, node_id: str, kind: str = "note") -> IndexingJob:
    now = datetime.now(timezone.utc)
    return IndexingJob(
        node_id=node_id,
        kind=kind,
        name=path.name,
        absolute_content_path=str(path),
        mount_id=None,
        state=JobState.INDEXING,
        enqueued_at=now,
        indexed_at=None,
        last_error=None,
        attempts=1,
        created_at=now,
        modified_at=now,
    )


@pytest.fixture
def client(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    embedder = StubEmbedder()
    proc = TextProcessor(store, embedder)

    note = tmp_path / "oauth.md"
    note.write_text("OAuth 2.1 PKCE refresh tokens rotate on each use.")
    proc.process(_make_job(note, node_id=UUID_A))

    orch = SearchOrchestrator(store=store, embedder=embedder)
    app = build_app(token=TOKEN, search_orchestrator=orch)
    with TestClient(app) as c:
        yield c


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_post_search_requires_bearer(client: TestClient):
    resp = client.post("/search", json={"query": "PKCE"})
    assert resp.status_code == 401


def test_post_search_returns_envelope(client: TestClient):
    resp = client.post("/search", json={"query": "PKCE"}, headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) >= {"results", "degraded", "partial", "state"}
    assert body["degraded"] is True
    assert isinstance(body["results"], list)
    assert any(r["node_id"] == UUID_A for r in body["results"])


def test_post_search_empty_query(client: TestClient):
    resp = client.post("/search", json={"query": ""}, headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["results"] == []


def test_post_search_with_inline_kind_filter(client: TestClient):
    resp = client.post(
        "/search", json={"query": "kind:note PKCE"}, headers=_auth()
    )
    assert resp.status_code == 200
    body = resp.json()
    for r in body["results"]:
        assert r["kind"] == "note"


def test_post_search_returns_500_when_orchestrator_missing():
    """Building an app without an orchestrator surfaces a typed
    503-like 500, not a crash."""
    app = build_app(token=TOKEN)
    with TestClient(app) as c:
        resp = c.post("/search", json={"query": "x"}, headers=_auth())
        assert resp.status_code == 500
        body = resp.json()
        assert "search_orchestrator" in body.get("detail", "").lower()


def test_post_search_respects_limit(client: TestClient):
    resp = client.post(
        "/search", json={"query": "oauth", "limit": 1}, headers=_auth()
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) <= 1
