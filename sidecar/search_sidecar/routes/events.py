"""Rust-to-sidecar event ingestion.

Two endpoints:

- ``POST /events/node`` — fire-and-forget mutation event. Rust calls
  this whenever a node is created, modified, or deleted.
- ``POST /events/resync`` — periodic id-set diff. Rust posts the full
  authoritative ``nodes`` id-set; the sidecar enqueues newly-seen ids
  and deletes index entries for ids no longer present.

Both routes do minimal work in the request thread — they update the
queue's persistent state and return. The actual indexing happens on
the runner's worker thread.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..index.queue import IndexingQueue
from ..storage import LanceDBStore

router = APIRouter(prefix="/events", tags=["events"])

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
KIND_VALUES = {"note", "file", "url", "folder", "mount"}


class NodeEvent(BaseModel):
    """Body of ``POST /events/node``.

    Schema mirrors the IPC contract documented in the plan
    Architecture section. ``absolute_content_path`` is optional because
    folders/mounts have no file body to index; for those, the runner
    enqueues the row but the dispatcher returns "no processor" and
    marks the job error — which is fine, container nodes don't need
    chunks.
    """

    event: Literal["node_changed", "node_deleted"]
    node_id: str = Field(..., min_length=1)
    kind: str
    name: str
    absolute_content_path: str | None = None
    mount_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    force: bool = True


class ResyncRequest(BaseModel):
    """Body of ``POST /events/resync``.

    ``ids`` is the full id-set Rust currently holds in ``cognios.db``
    (the ``nodes`` table). The sidecar diffs against its own queue +
    lancedb state and reconciles.
    """

    ids: list[str] = Field(default_factory=list)


class ResyncResponse(BaseModel):
    added: int
    removed: int


def _validate_node_id(node_id: str) -> None:
    """SEC-FINDING-005 mitigation. ``node_id`` flows from Rust events
    into lancedb WHERE clauses; tighten the format here."""
    if not UUID_RE.match(node_id):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_node_id", "message": "node_id must be UUID"},
        )


def _validate_kind(kind: str) -> None:
    if kind not in KIND_VALUES:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_kind", "message": f"kind {kind!r} not allowed"},
        )


def _get_queue(request: Request) -> IndexingQueue:
    queue = getattr(request.app.state, "indexing_queue", None)
    if queue is None:
        raise HTTPException(
            status_code=500,
            detail="indexing_queue not configured on app.state",
        )
    return queue


def _get_store(request: Request) -> LanceDBStore | None:
    return getattr(request.app.state, "lancedb_store", None)


@router.post("/node")
def post_node_event(body: NodeEvent, request: Request) -> dict:
    _validate_node_id(body.node_id)

    queue = _get_queue(request)
    store = _get_store(request)

    if body.event == "node_deleted":
        # Deletion events carry only ``node_id`` — the row is already
        # gone in cognios.db so Rust cannot include kind/name/path.
        # Skip the kind allowlist check (it would 400 on the empty
        # string the forwarder sends) and clear queue + lancedb by id.
        queue.remove(body.node_id)
        if store is not None:
            store.delete_by_node_id(body.node_id)
        return {"accepted": True, "action": "deleted"}

    # node_changed: kind drives processor selection + filter SQL, so
    # validate it here (after the deletion branch so deletes aren't
    # blocked).
    _validate_kind(body.kind)
    if store is not None:
        store.update_node_metadata(
            body.node_id,
            kind=body.kind,
            name=body.name,
            mount_id=body.mount_id,
            modified_at=body.updated_at,
        )

    queue.enqueue(
        node_id=body.node_id,
        kind=body.kind,
        name=body.name,
        absolute_content_path=body.absolute_content_path,
        mount_id=body.mount_id,
        created_at=body.created_at,
        modified_at=body.updated_at,
        force=body.force,
    )
    return {"accepted": True, "action": "enqueued"}


@router.post("/resync", response_model=ResyncResponse)
def post_resync(body: ResyncRequest, request: Request) -> ResyncResponse:
    """Reconcile against the authoritative id-set.

    For ids in ``body.ids`` not yet known to the sidecar, enqueue a
    placeholder ``pending`` job with kind=``unknown``. Rust is expected
    to follow up with full ``POST /events/node`` payloads (carrying
    paths + names) for any newly-seen ids — this resync only catches
    drift, it does not encode the full mutation stream.

    For ids in our queue/lancedb state but absent from ``body.ids``,
    delete from both.
    """
    for node_id in body.ids:
        _validate_node_id(node_id)

    queue = _get_queue(request)
    store = _get_store(request)
    authoritative = set(body.ids)

    known = queue.list_node_ids()
    if store is not None:
        known.update(store.list_node_ids())

    # Removals: known but not in authoritative set
    to_remove = known - authoritative
    for node_id in to_remove:
        queue.remove(node_id)
        if store is not None:
            store.delete_by_node_id(node_id)

    # Additions: authoritative but not known
    to_add = authoritative - known
    for node_id in to_add:
        # Placeholder enqueue. Rust's next /events/node will fill in
        # the real kind/name/path; this just gets it on the queue.
        queue.enqueue(
            node_id=node_id,
            kind="unknown",
            name=node_id,
        )

    return ResyncResponse(added=len(to_add), removed=len(to_remove))


def _is_uuid_like(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False
