"""``/events/*`` and ``/index/*`` HTTP routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.queue import JobState, open_queue
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.storage import open_store

TOKEN = "0123456789abcdef" * 4
UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def stack(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    dispatcher = Dispatcher(store=store, embedder=StubEmbedder())
    runner = IndexingRunner(queue=queue, dispatcher=dispatcher)
    app = build_app(token=TOKEN, indexing_queue=queue, lancedb_store=store)
    yield app, queue, store, runner, tmp_path
    runner.stop()
    queue.close()


def test_post_node_event_enqueues(stack):
    app, queue, _, _, tmp_path = stack
    note = tmp_path / "note.md"
    note.write_text("hi")
    with TestClient(app) as client:
        resp = client.post(
            "/events/node",
            headers=_auth(),
            json={
                "event": "node_changed",
                "node_id": UUID_A,
                "kind": "note",
                "name": "note.md",
                "absolute_content_path": str(note),
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": True, "action": "enqueued"}
    assert queue.queue_depth() == 1


def test_post_node_event_deletion_drops_from_queue_and_store(stack):
    app, queue, store, runner, tmp_path = stack
    note = tmp_path / "note.md"
    note.write_text("hi")
    with TestClient(app) as client:
        client.post(
            "/events/node",
            headers=_auth(),
            json={
                "event": "node_changed",
                "node_id": UUID_A,
                "kind": "note",
                "name": "note.md",
                "absolute_content_path": str(note),
            },
        )
        # Synchronously drain so the chunk lands in the store
        runner.process_one()
        assert store.count() == 1

        # The Rust forwarder sends ``kind: ""`` and ``name: ""`` for
        # deletes because the row is already gone from cognios.db —
        # only the node_id is available. The route must accept this
        # shape and not run the kind allowlist on it.
        resp = client.post(
            "/events/node",
            headers=_auth(),
            json={
                "event": "node_deleted",
                "node_id": UUID_A,
                "kind": "",
                "name": "",
            },
        )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": True, "action": "deleted"}
    assert queue.get(UUID_A) is None
    assert store.count() == 0


def test_post_node_event_deletion_does_not_run_kind_allowlist(stack):
    """Regression: ``kind`` validation used to run unconditionally
    before the deleted-event branch, which 400'd every delete the
    Rust forwarder sent (kind is always empty for deletes). Pinning
    the contract: a deletion with any kind value — including the
    empty string the forwarder uses — must succeed."""
    app, queue, store, _, _ = stack
    with TestClient(app) as client:
        for kind_value in ("", "note", "weird-kind"):
            resp = client.post(
                "/events/node",
                headers=_auth(),
                json={
                    "event": "node_deleted",
                    "node_id": UUID_A,
                    "kind": kind_value,
                    "name": "",
                },
            )
            assert resp.status_code == 200, (
                f"delete rejected for kind={kind_value!r}: {resp.json()}"
            )


def test_post_node_event_rejects_bad_uuid(stack):
    app, queue, _, _, _ = stack
    with TestClient(app) as client:
        resp = client.post(
            "/events/node",
            headers=_auth(),
            json={
                "event": "node_changed",
                "node_id": "not-a-uuid",
                "kind": "note",
                "name": "x",
            },
        )
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "invalid_node_id"
    assert queue.queue_depth() == 0


def test_post_node_event_rejects_unknown_kind(stack):
    app, queue, _, _, _ = stack
    with TestClient(app) as client:
        resp = client.post(
            "/events/node",
            headers=_auth(),
            json={
                "event": "node_changed",
                "node_id": UUID_A,
                "kind": "weird-kind",
                "name": "x",
            },
        )
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "invalid_kind"


def test_post_resync_adds_unknown_and_removes_orphaned(stack):
    app, queue, store, runner, tmp_path = stack
    # Pre-seed: B is in our state (queued + indexed in store), A is not
    note = tmp_path / "b.md"
    note.write_text("b body")
    queue.enqueue(
        node_id=UUID_B,
        kind="note",
        name="b.md",
        absolute_content_path=str(note),
    )
    runner.process_one()
    assert store.list_node_ids() == {UUID_B}

    # Authoritative set has A but not B
    with TestClient(app) as client:
        resp = client.post(
            "/events/resync",
            headers=_auth(),
            json={"ids": [UUID_A]},
        )
    body = resp.json()
    assert body["added"] == 1
    assert body["removed"] == 1

    # B was removed, A was added (placeholder kind=unknown)
    assert store.list_node_ids() == set()
    a = queue.get(UUID_A)
    assert a is not None
    assert a.kind == "unknown"
    assert a.state == JobState.PENDING


def test_get_index_status_aggregates_state(stack):
    app, queue, _, _, _ = stack
    queue.enqueue(node_id=UUID_A, kind="note", name="A")
    queue.enqueue(node_id=UUID_B, kind="note", name="B")
    queue.claim_next()  # one in flight
    with TestClient(app) as client:
        resp = client.get("/index/status", headers=_auth())
    body = resp.json()
    assert body["queue_depth"] == 1
    assert len(body["in_flight"]) == 1
    assert body["indexed_chunks"] == 0


def test_get_node_status_returns_unknown_for_unseen_id(stack):
    app, _, _, _, _ = stack
    with TestClient(app) as client:
        resp = client.get(f"/index/status/{UUID_A}", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "unknown"
    assert body["attempts"] == 0


def test_get_node_status_returns_indexed_after_processing(stack):
    app, queue, _, runner, tmp_path = stack
    note = tmp_path / "note.md"
    note.write_text("hi")
    queue.enqueue(
        node_id=UUID_A,
        kind="note",
        name="note.md",
        absolute_content_path=str(note),
    )
    runner.process_one()
    with TestClient(app) as client:
        resp = client.get(f"/index/status/{UUID_A}", headers=_auth())
    body = resp.json()
    assert body["state"] == "indexed"
    assert body["attempts"] == 1
    assert body["indexed_at"] is not None


def test_healthz_includes_queue_depth(stack):
    app, queue, _, _, _ = stack
    queue.enqueue(node_id=UUID_A, kind="note", name="A")
    with TestClient(app) as client:
        resp = client.get("/healthz", headers=_auth())
    body = resp.json()
    assert body["queue_depth"] == 1


def test_routes_require_bearer_auth(stack):
    app, _, _, _, _ = stack
    with TestClient(app) as client:
        for path in ("/events/node", "/events/resync", "/index/status", f"/index/status/{UUID_A}"):
            resp = client.post(path, json={}) if path.startswith("/events") else client.get(path)
            assert resp.status_code == 401, path
