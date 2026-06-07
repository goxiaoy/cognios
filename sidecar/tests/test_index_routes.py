"""Current ``/index/*`` HTTP routes."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.retrieval import SearchOrchestrator
from search_sidecar.storage import EMBEDDING_DIMENSION, NodeChunk, open_store

TOKEN = "0123456789abcdef" * 4
UUID_A = "11111111-1111-1111-1111-111111111111"


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def _app(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    embedder = StubEmbedder()
    dispatcher = Dispatcher(store=store, embedder=embedder)
    runner = IndexingRunner(dispatcher=dispatcher)
    app = build_app(
        token=TOKEN,
        indexing_runner=runner,
        embedder=embedder,
        lancedb_store=store,
        search_orchestrator=SearchOrchestrator(store=store, embedder=embedder),
    )
    return app, store


def test_post_index_node_processes_requested_node_without_queue(tmp_path: Path):
    app, store = _app(tmp_path)
    note = tmp_path / "note.md"
    note.write_text("hello from direct index")

    with TestClient(app) as client:
        resp = client.post(
            "/index/node",
            headers=_auth(),
            json={
                "node_id": UUID_A,
                "kind": "note",
                "name": "note.md",
                "absolute_content_path": str(note),
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["node_id"] == UUID_A
    assert body["status"] == "indexed"
    assert body["error"] is None
    assert store.count() == 2
    assert not (tmp_path / "queue.db").exists()


def test_post_index_node_metadata_only_rename_updates_metadata(tmp_path: Path):
    app, store = _app(tmp_path)
    note = tmp_path / "note.md"
    note.write_text("hello")

    with TestClient(app) as client:
        initial = client.post(
            "/index/node",
            headers=_auth(),
            json={
                "node_id": UUID_A,
                "kind": "note",
                "name": "note.md",
                "absolute_content_path": str(note),
                "updated_at": "2026-05-08T00:00:00Z",
            },
        )
        assert initial.status_code == 200

        resp = client.post(
            "/index/node",
            headers=_auth(),
            json={
                "node_id": UUID_A,
                "kind": "note",
                "name": "renamed.md",
                "absolute_content_path": str(note),
                "updated_at": "2026-05-08T00:00:00Z",
                "force": False,
            },
        )

    assert resp.status_code == 200
    assert resp.json()["status"] == "indexed"
    assert {row["name"] for row in store.scan(UUID_A)} == {"renamed.md"}


def test_post_delete_node_removes_lancedb_rows(tmp_path: Path):
    app, store = _app(tmp_path)
    store.replace_node_chunks(
        UUID_A,
        [
            NodeChunk(
                id=f"{UUID_A}:body:0",
                node_id=UUID_A,
                kind="note",
                name="A",
                text="hello",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="body",
            )
        ],
    )

    with TestClient(app) as client:
        resp = client.post("/index/delete", headers=_auth(), json={"node_id": UUID_A})

    assert resp.status_code == 200
    assert resp.json() == {"node_id": UUID_A, "status": "deleted", "error": None}
    assert store.count() == 0


def test_legacy_events_router_is_not_mounted_by_default():
    app = build_app(token=TOKEN)
    with TestClient(app) as client:
        resp = client.post("/events/node", headers=_auth(), json={})
    assert resp.status_code == 404


def test_routes_require_bearer_auth(tmp_path: Path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client:
        assert client.get("/index/status").status_code == 401
        assert client.post("/index/node", json={}).status_code == 401


def test_enhancement_start_reports_unavailable_without_runtime(tmp_path: Path):
    app, _ = _app(tmp_path)

    with TestClient(app) as client:
        resp = client.post(
            "/index/enhance/start",
            headers=_auth(),
            json={
                "node_id": UUID_A,
                "kind": "file",
                "name": "scan.png",
                "absolute_content_path": str(tmp_path / "scan.png"),
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "job_id": None,
        "node_id": UUID_A,
        "status": "unavailable",
        "error": "advanced OCR runtime is unavailable",
    }


def test_enhancement_status_reports_unknown_job(tmp_path: Path):
    app, _ = _app(tmp_path)

    with TestClient(app) as client:
        resp = client.get("/index/enhance/missing-job", headers=_auth())

    assert resp.status_code == 200
    assert resp.json() == {
        "job_id": "missing-job",
        "node_id": None,
        "status": "unknown",
        "error": "enhancement job unknown",
    }


def test_get_node_content_returns_empty_for_unindexed_node(tmp_path: Path):
    app, _ = _app(tmp_path)
    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())
    assert resp.status_code == 200
    assert resp.json() == {
        "node_id": UUID_A,
        "kind": None,
        "chunks": [],
        "joined": "",
        "assets": {},
    }


def test_get_node_content_concatenates_chunks_in_order(tmp_path: Path):
    app, store = _app(tmp_path)
    store.replace_node_chunks(
        UUID_A,
        [
            NodeChunk(
                id=f"{UUID_A}:body:1",
                node_id=UUID_A,
                kind="note",
                name="A",
                text="second",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="body",
            ),
            NodeChunk(
                id=f"{UUID_A}:body:0",
                node_id=UUID_A,
                kind="note",
                name="A",
                text="first",
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="body",
            ),
        ],
    )

    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["joined"] == "first\n\nsecond"
    assert [chunk["text"] for chunk in body["chunks"]] == ["first", "second"]
