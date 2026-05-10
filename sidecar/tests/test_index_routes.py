"""``/events/*`` and ``/index/*`` HTTP routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.extract_artifacts import write_extract_artifact
from search_sidecar.index.queue import JobState, open_queue
from search_sidecar.index.runner import IndexingRunner
from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
from search_sidecar.storage import EMBEDDING_DIMENSION, NodeChunk, open_store

TOKEN = "0123456789abcdef" * 4
UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"


class DummyImage:
    def save(self, path: Path, *, format: str | None = None) -> None:
        path.write_bytes(b"dummy image")


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def stack(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    embedder = StubEmbedder()
    dispatcher = Dispatcher(store=store, embedder=embedder)
    runner = IndexingRunner(queue=queue, dispatcher=dispatcher)
    app = build_app(
        token=TOKEN,
        indexing_queue=queue,
        indexing_runner=runner,
        embedder=embedder,
        lancedb_store=store,
    )
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
        assert store.count() == 2

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


def test_post_node_event_non_forced_duplicate_keeps_indexed_state(stack):
    app, queue, store, runner, tmp_path = stack
    note = tmp_path / "note.md"
    note.write_text("hi")
    body = {
        "event": "node_changed",
        "node_id": UUID_A,
        "kind": "note",
        "name": "note.md",
        "absolute_content_path": str(note),
        "updated_at": "2026-05-08T00:00:00Z",
    }
    with TestClient(app) as client:
        resp = client.post("/events/node", headers=_auth(), json=body)
        assert resp.status_code == 200
        runner.process_one()
        assert queue.get(UUID_A).state == JobState.INDEXED

        resp = client.post(
            "/events/node",
            headers=_auth(),
            json={**body, "name": "renamed.md", "force": False},
        )
    assert resp.status_code == 200
    assert queue.get(UUID_A).state == JobState.INDEXED
    rows = store.scan(UUID_A)
    assert {row["name"] for row in rows} == {"renamed.md"}
    orch = SearchOrchestrator(store=store, embedder=StubEmbedder())
    search = orch.search(SearchRequest(query="renamed"))
    assert [result.node_id for result in search.results] == [UUID_A]


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
    assert body["enhancement_in_flight"] == []
    assert body["indexed_chunks"] == 0
    assert body["enhancement_pending"] == 0
    assert body["enhancement_failed"] == 0
    assert body["enhancement_total_images"] == 0


def test_get_index_status_includes_enhancement_counts(stack):
    app, queue, _, _, _ = stack
    for node_id, name in [
        (UUID_A, "a.png"),
        (UUID_B, "b.png"),
        ("33333333-3333-3333-3333-333333333333", "c.png"),
        ("44444444-4444-4444-4444-444444444444", "notes.pdf"),
    ]:
        queue.enqueue(node_id=node_id, kind="file", name=name)
        queue.claim_next()
        queue.mark_indexed(node_id)
    queue.set_enhancement_pending(UUID_A)
    queue.mark_enhancement_failed(UUID_B)

    with TestClient(app) as client:
        resp = client.get("/index/status", headers=_auth())
    body = resp.json()
    assert body["enhancement_pending"] == 1
    assert body["enhancement_failed"] == 1
    assert body["enhancement_total_images"] == 4


def test_post_pause_toggles_runner_pause(stack):
    app, _, _, runner, _ = stack
    assert runner.paused is False

    with TestClient(app) as client:
        paused = client.post(
            "/index/pause",
            headers=_auth(),
            json={"paused": True},
        )
        resumed = client.post(
            "/index/pause",
            headers=_auth(),
            json={"paused": False},
        )

    assert paused.status_code == 200
    assert paused.json() == {"paused": True}
    assert resumed.json() == {"paused": False}
    assert runner.paused is False


def test_post_backfill_enhancement_flags_indexed_documents(stack):
    app, queue, _, _, _ = stack
    for node_id, name in [
        (UUID_A, "a.png"),
        (UUID_B, "b.JPG"),
        ("33333333-3333-3333-3333-333333333333", "doc.pdf"),
    ]:
        queue.enqueue(node_id=node_id, kind="file", name=name)
        queue.claim_next()
        queue.mark_indexed(node_id)

    with TestClient(app) as client:
        resp = client.post("/index/backfill-enhancement", headers=_auth())
        second = client.post("/index/backfill-enhancement", headers=_auth())

    assert resp.status_code == 200
    assert resp.json() == {"flagged": 3}
    assert second.json() == {"flagged": 0}


def test_post_backfill_enhancement_skips_failed_rows(stack):
    app, queue, _, _, _ = stack
    queue.enqueue(node_id=UUID_A, kind="file", name="a.png")
    queue.claim_next()
    queue.mark_indexed(UUID_A)
    queue.mark_enhancement_failed(UUID_A)

    with TestClient(app) as client:
        resp = client.post("/index/backfill-enhancement", headers=_auth())

    assert resp.json() == {"flagged": 0}


def test_post_backfill_enhancement_requires_auth(stack):
    app, _, _, _, _ = stack
    with TestClient(app) as client:
        resp = client.post("/index/backfill-enhancement")
    assert resp.status_code == 401


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


def test_get_index_changes_returns_only_new_transitions(stack):
    """``/index/changes?since=<seq>`` returns rows newer than the
    cursor and an advanceable ``next_seq``."""
    app, queue, _, runner, tmp_path = stack
    note_a = tmp_path / "a.md"
    note_a.write_text("a")
    note_b = tmp_path / "b.md"
    note_b.write_text("b")
    queue.enqueue(
        node_id=UUID_A, kind="note", name="a.md",
        absolute_content_path=str(note_a),
    )
    queue.enqueue(
        node_id=UUID_B, kind="note", name="b.md",
        absolute_content_path=str(note_b),
    )

    with TestClient(app) as client:
        resp = client.get("/index/changes?since=0", headers=_auth())
        body = resp.json()
        assert {t["node_id"] for t in body["transitions"]} == {UUID_A, UUID_B}
        assert all(t["state"] == "pending" for t in body["transitions"])
        cursor = body["next_seq"]
        assert cursor > 0

        # No new transitions yet
        empty = client.get(f"/index/changes?since={cursor}", headers=_auth()).json()
        assert empty["transitions"] == []
        assert empty["next_seq"] == 0

        # Process A → next poll surfaces just A as indexed
        runner.process_one()
        new_body = client.get(f"/index/changes?since={cursor}", headers=_auth()).json()
        assert len(new_body["transitions"]) == 1
        assert new_body["transitions"][0]["node_id"] == UUID_A
        assert new_body["transitions"][0]["state"] == "indexed"


def test_get_index_changes_caps_limit_server_side(stack):
    """A pathological ``limit`` query value can't blow up the response."""
    app, queue, _, _, _ = stack
    for i in range(3):
        queue.enqueue(node_id=f"{i:08d}-1111-1111-1111-111111111111",
                      kind="note", name=f"n{i}")
    with TestClient(app) as client:
        # ``limit=99999999`` must be capped, not rejected.
        resp = client.get("/index/changes?since=0&limit=99999999", headers=_auth())
        assert resp.status_code == 200
        assert len(resp.json()["transitions"]) == 3


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


def test_get_node_content_returns_empty_for_unindexed_node(stack):
    app, _, _, _, _ = stack
    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "node_id": UUID_A,
        "kind": None,
        "chunks": [],
        "joined": "",
        "assets": {},
    }


def test_get_node_content_concatenates_chunks_in_order(stack):
    app, queue, store, runner, tmp_path = stack
    # Synthesise a multi-paragraph note that the chunker will split
    # into multiple chunks. Lexicographic chunk-id sort would put
    # ``:10`` before ``:2``; the route's int-suffix sort keeps the
    # natural reading order.
    note = tmp_path / "n.md"
    note.write_text(
        "\n\n".join(f"Paragraph {i} body content here." for i in range(12))
    )
    queue.enqueue(
        node_id=UUID_A,
        kind="note",
        name="n.md",
        absolute_content_path=str(note),
    )
    runner.process_one()
    assert store.count() >= 1

    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())
    body = resp.json()
    assert body["node_id"] == UUID_A
    assert body["kind"] == "note"
    assert len(body["chunks"]) >= 1
    # Every chunk surfaces a role; text-processor output is all body.
    assert {c["role"] for c in body["chunks"]} == {"body"}
    # Joined text must keep paragraphs in source order.
    joined = body["joined"]
    pos_2 = joined.find("Paragraph 2 ")
    pos_10 = joined.find("Paragraph 10 ")
    assert pos_2 != -1 and pos_10 != -1
    assert pos_2 < pos_10, "Paragraph 10 must appear after Paragraph 2"


def test_get_node_content_orders_body_then_summary(stack):
    """Body chunks sort first (by numeric idx), summary chunks sort
    after (also by numeric idx). The ``role`` field carries through
    to the response."""
    from datetime import datetime, timezone

    app, _queue, store, _runner, _tmp = stack
    now = datetime.now(timezone.utc)
    vec = [0.0] * EMBEDDING_DIMENSION
    # Insert intentionally out-of-order: summary first, then body
    # 10/0/2/1/11 — the route must reorder.
    rows = [
        NodeChunk(
            id=f"{UUID_A}:summary:1",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="Caption part two.",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="summary",
        ),
        NodeChunk(
            id=f"{UUID_A}:summary:0",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="Caption part one.",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="summary",
        ),
        NodeChunk(
            id=f"{UUID_A}:10",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="Body line 10.",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="body",
        ),
        NodeChunk(
            id=f"{UUID_A}:2",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="Body line 2.",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="body",
        ),
        NodeChunk(
            id=f"{UUID_A}:0",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="Body line 0.",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="body",
        ),
        NodeChunk(
            id=f"{UUID_A}:metadata:0",
            node_id=UUID_A,
            kind="file",
            name="img.png",
            text="img.png\n/private/tmp/img.png",
            vector=vec,
            created_at=now,
            modified_at=now,
            role="metadata",
        ),
    ]
    store.upsert(rows)
    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())
    body = resp.json()
    ids_in_order = [c["id"] for c in body["chunks"]]
    assert ids_in_order == [
        f"{UUID_A}:0",
        f"{UUID_A}:2",
        f"{UUID_A}:10",
        f"{UUID_A}:summary:0",
        f"{UUID_A}:summary:1",
    ]
    roles_in_order = [c["role"] for c in body["chunks"]]
    assert roles_in_order == ["body", "body", "body", "summary", "summary"]
    assert f"{UUID_A}:metadata:0" not in ids_in_order
    # Joined keeps the same order; summary text appears after body.
    joined = body["joined"]
    body_end = joined.find("Body line 10.")
    summary_start = joined.find("Caption part one.")
    assert body_end != -1 and summary_start != -1
    assert body_end < summary_start


def test_get_node_content_prefers_cached_advanced_artifact(tmp_path: Path):
    """Image preview reads extract artifacts directly.

    ``advanced.md`` is the preferred OCR body when present; ``basic.md``
    and stale lancedb body rows must not leak into the preview.
    """
    from datetime import datetime, timezone

    extract_dir = tmp_path / "extract"
    write_extract_artifact(extract_dir, UUID_A, "basic", "basic OCR text")
    write_extract_artifact(extract_dir, UUID_A, "advanced", "advanced OCR table")
    write_extract_artifact(extract_dir, UUID_A, "caption", "caption text")

    store = open_store(tmp_path / "index.lance")
    now = datetime.now(timezone.utc)
    store.upsert(
        [
            NodeChunk(
                id=f"{UUID_A}:0",
                node_id=UUID_A,
                kind="file",
                name="img.png",
                text="stale lancedb OCR",
                vector=[0.0] * EMBEDDING_DIMENSION,
                created_at=now,
                modified_at=now,
            )
        ]
    )
    app = build_app(token=TOKEN, lancedb_store=store, extract_dir=extract_dir)

    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "file"
    assert body["chunks"] == [
        {
            "id": f"{UUID_A}:extract:advanced",
            "role": "body",
            "text": "advanced OCR table",
        },
        {
            "id": f"{UUID_A}:extract:caption",
            "role": "summary",
            "text": "caption text",
        },
    ]
    assert "basic OCR text" not in body["joined"]
    assert "stale lancedb OCR" not in body["joined"]
    assert body["assets"] == {}


def test_get_node_content_returns_cached_advanced_assets(tmp_path: Path):
    extract_dir = tmp_path / "extract"
    write_extract_artifact(
        extract_dir,
        UUID_A,
        "advanced",
        '<img src="imgs/crop.jpg" alt="crop" />',
        assets={"imgs/crop.jpg": DummyImage()},
    )
    app = build_app(token=TOKEN, extract_dir=extract_dir)

    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["chunks"][0]["text"] == '<img src="imgs/crop.jpg" alt="crop" />'
    assert body["assets"] == {
        "imgs/crop.jpg": str(
            extract_dir / UUID_A / "assets" / "advanced" / "imgs" / "crop.png"
        )
    }


def test_get_node_content_falls_back_to_cached_basic_artifact(tmp_path: Path):
    extract_dir = tmp_path / "extract"
    write_extract_artifact(extract_dir, UUID_A, "basic", "basic OCR text")
    app = build_app(token=TOKEN, extract_dir=extract_dir)

    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_A}/content", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["chunks"] == [
        {
            "id": f"{UUID_A}:extract:basic",
            "role": "body",
            "text": "basic OCR text",
        }
    ]
    assert body["joined"] == "basic OCR text"


def test_get_node_content_returns_unindexed_node_unchanged(stack):
    """Empty stores still emit the documented shape — chunks list and
    joined string both empty, no role chatter."""
    app, _queue, _store, _runner, _tmp = stack
    with TestClient(app) as client:
        resp = client.get(f"/index/node/{UUID_B}/content", headers=_auth())
    assert resp.status_code == 200
    assert resp.json() == {
        "node_id": UUID_B,
        "kind": None,
        "chunks": [],
        "joined": "",
        "assets": {},
    }
