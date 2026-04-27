"""GET /index/snapshot — the diff-first resync's input."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.queue import open_queue

TOKEN = "0" * 64
UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


def _client(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    app = build_app(token=TOKEN, indexing_queue=queue)
    return TestClient(app), queue


def _auth():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_empty_snapshot(tmp_path: Path):
    client, queue = _client(tmp_path)
    try:
        with client:
            resp = client.get("/index/snapshot", headers=_auth())
            assert resp.status_code == 200
            assert resp.json() == {"nodes": {}}
    finally:
        queue.close()


def test_snapshot_returns_state_and_modified_at_per_node(tmp_path: Path):
    client, queue = _client(tmp_path)
    try:
        modified = datetime(2026, 4, 27, 10, 0, 0, tzinfo=timezone.utc)
        queue.enqueue(
            node_id=UUID_A,
            kind="note",
            name="A",
            absolute_content_path="/tmp/a.md",
            modified_at=modified,
        )
        queue.enqueue(
            node_id=UUID_B,
            kind="note",
            name="B",
            absolute_content_path="/tmp/b.md",
        )
        # Move A through the state machine
        queue.claim_next()
        queue.mark_indexed(UUID_A)

        with client:
            resp = client.get("/index/snapshot", headers=_auth())
        body = resp.json()["nodes"]

        assert set(body.keys()) == {UUID_A, UUID_B}
        assert body[UUID_A]["state"] == "indexed"
        assert body[UUID_A]["modified_at"] == modified.isoformat()
        assert body[UUID_B]["state"] == "pending"
    finally:
        queue.close()


def test_snapshot_requires_bearer(tmp_path: Path):
    client, queue = _client(tmp_path)
    try:
        with client:
            resp = client.get("/index/snapshot")
            assert resp.status_code == 401
    finally:
        queue.close()
