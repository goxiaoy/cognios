"""``/index/*`` — direct indexing endpoints and lancedb status views.

Rust owns durable task state in ``cognios.db`` and calls these endpoints
when a worker claims a ``search.index`` or ``image.enhance`` task. The
sidecar writes LanceDB data and returns the processor result; it no
longer owns runtime queue state.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..index.content import NodeContentReader
from ..index.embedder import Embedder
from ..index.metadata import replace_metadata_chunk
from ..storage import LanceDBStore

router = APIRouter(prefix="/index", tags=["index"])
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
KIND_VALUES = {"note", "file", "url", "folder", "mount"}


class RunnerPauseRequest(BaseModel):
    paused: bool


class IndexNodeRequest(BaseModel):
    node_id: str
    kind: str
    name: str
    absolute_content_path: str | None = None
    mount_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    force: bool = True


class DeleteNodeRequest(BaseModel):
    node_id: str


def _get_store(request: Request) -> LanceDBStore | None:
    return getattr(request.app.state, "lancedb_store", None)


def _get_embedder(request: Request) -> Embedder | None:
    return getattr(request.app.state, "embedder", None)


def _get_extract_dir(request: Request) -> Path | None:
    return getattr(request.app.state, "extract_dir", None)


def _get_runner(request: Request):
    return getattr(request.app.state, "indexing_runner", None)


def _validate_index_node(body: IndexNodeRequest) -> None:
    if not UUID_RE.match(body.node_id):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_node_id", "message": "node_id must be UUID"},
        )
    if body.kind not in KIND_VALUES:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_kind", "message": f"kind {body.kind!r} not allowed"},
        )


@router.get("/status")
def get_index_status(request: Request) -> dict:
    """Aggregate sidecar index health for the sidebar footer."""
    store = _get_store(request)
    runner = _get_runner(request)
    return {
        "in_flight": [],
        "enhancement_in_flight": (
            runner.enhancement_in_flight_node_ids if runner is not None else []
        ),
        "indexed_chunks": store.count() if store is not None else 0,
        "enhancement_pending": 0,
        "enhancement_failed": 0,
        "enhancement_total_images": 0,
    }


@router.post("/node")
def post_index_node(body: IndexNodeRequest, request: Request) -> dict:
    _validate_index_node(body)
    store = _get_store(request)
    runner = _get_runner(request)
    if runner is None:
        raise HTTPException(
            status_code=500,
            detail="indexing_runner not configured on app.state",
        )

    if store is not None:
        store.update_node_metadata(
            body.node_id,
            kind=body.kind,
            name=body.name,
            mount_id=body.mount_id,
            modified_at=body.updated_at,
        )
        replace_metadata_chunk(
            store,
            _get_embedder(request),
            node_id=body.node_id,
            kind=body.kind,
            name=body.name,
            absolute_content_path=body.absolute_content_path,
            mount_id=body.mount_id,
            created_at=body.created_at,
            modified_at=body.updated_at,
        )

    result = runner.process_direct(
        node_id=body.node_id,
        kind=body.kind,
        name=body.name,
        absolute_content_path=body.absolute_content_path,
        mount_id=body.mount_id,
        created_at=body.created_at,
        modified_at=body.updated_at,
    )
    return {"node_id": body.node_id, **result}


@router.post("/enhance")
def post_enhance_node(body: IndexNodeRequest, request: Request) -> dict:
    _validate_index_node(body)
    runner = _get_runner(request)
    if runner is None:
        raise HTTPException(
            status_code=500,
            detail="indexing_runner not configured on app.state",
        )
    return runner.process_direct_enhancement(
        node_id=body.node_id,
        kind=body.kind,
        name=body.name,
        absolute_content_path=body.absolute_content_path,
        mount_id=body.mount_id,
        created_at=body.created_at,
        modified_at=body.updated_at,
    )


@router.post("/delete")
def post_delete_node(body: DeleteNodeRequest, request: Request) -> dict:
    if not UUID_RE.match(body.node_id):
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_node_id", "message": "node_id must be UUID"},
        )
    store = _get_store(request)
    if store is not None:
        store.delete_by_node_id(body.node_id)
    return {"node_id": body.node_id, "status": "deleted", "error": None}


@router.post("/pause")
def post_runner_pause(body: RunnerPauseRequest, request: Request) -> dict:
    """Pause/resume new index claims while allowing in-flight work to finish."""
    runner = _get_runner(request)
    if runner is None:
        raise HTTPException(
            status_code=500,
            detail="indexing_runner not configured on app.state",
        )
    runner.set_paused(body.paused)
    return {"paused": runner.paused}


@router.get("/node/{node_id}/content")
def get_node_content(node_id: str, request: Request) -> dict:
    """Indexed or cached extracted text for a single node.

    Returns the raw user-visible chunk array (each entry tagged with
    its ``role`` — ``"body"`` for literal content, ``"summary"`` for
    generated descriptions like image captions, or
    ``"voice_transcript"`` for voice-note transcript files) plus a
    ``joined`` field. Internal ``"metadata"`` rows power title/path
    search and are intentionally hidden from this preview endpoint.

    Chunks are sorted via ``_chunk_index_key``: body rows first (by
    numeric chunk-index ascending), then summary rows (also by
    numeric index). ``joined`` is the concatenation of every
    non-empty chunk's text in that order, separated by ``\\n\\n``.
    The same ``\\n\\n`` separates intra-body, intra-summary, and the
    body/summary boundary — there is no special role-boundary
    delimiter. Consumers that need to distinguish body from summary
    text should iterate ``chunks`` filtered by ``role`` rather than
    parsing ``joined``.

    Used by the image preview surface, which filters ``chunks`` by
    role to render OCR (body) and Caption (summary) sections. When
    image extraction artifacts exist on disk, those are authoritative
    for preview: ``advanced.md`` beats ``basic.md`` for OCR, and
    ``caption.md`` renders as summary.

    Returns ``{node_id, kind, chunks: [], joined: ""}`` for nodes
    that have nothing in lancedb yet (image-only PDF, image with no
    extractors wired, fresh node before the runner drains).
    """
    return NodeContentReader(
        store=_get_store(request),
        extract_dir=_get_extract_dir(request),
    ).read(node_id).to_dict()
