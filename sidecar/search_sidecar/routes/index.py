"""``/index/*`` — read-only views into the queue + lancedb state.

Used by Rust's ``/healthz`` polling and by future UI surfaces (the
sidebar-footer queue indicator, the inspector's per-node ``indexed_at``
field). All endpoints are bearer-authenticated by the global
middleware.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..index.extract_artifacts import read_image_preview_artifacts
from ..index.processors.image import SUPPORTED_EXTENSIONS as IMAGE_EXTENSIONS
from ..index.processors.pdf import SUPPORTED_EXTENSIONS as PDF_EXTENSIONS
from ..index.queue import IndexingQueue, JobState
from ..storage import LanceDBStore, role_or_default

router = APIRouter(prefix="/index", tags=["index"])
ENHANCEMENT_EXTENSIONS = IMAGE_EXTENSIONS + PDF_EXTENSIONS


class RunnerPauseRequest(BaseModel):
    paused: bool


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


def _get_extract_dir(request: Request) -> Path | None:
    return getattr(request.app.state, "extract_dir", None)


def _get_runner(request: Request):
    return getattr(request.app.state, "indexing_runner", None)


def _get_enhancement_extensions(request: Request) -> tuple[str, ...]:
    return getattr(request.app.state, "enhancement_extensions", ENHANCEMENT_EXTENSIONS)


@router.get("/status")
def get_index_status(request: Request) -> dict:
    """Aggregate queue + index health for the sidebar footer."""
    queue = _get_queue(request)
    store = _get_store(request)
    runner = _get_runner(request)
    return {
        "queue_depth": queue.queue_depth(),
        "in_flight": queue.in_flight_node_ids(),
        "enhancement_in_flight": (
            runner.enhancement_in_flight_node_ids if runner is not None else []
        ),
        "indexed_chunks": store.count() if store is not None else 0,
        "enhancement_pending": queue.count_enhancement_pending(),
        "enhancement_failed": queue.count_enhancement_failed(),
        "enhancement_total_images": queue.count_enhancement_eligible_total(
            _get_enhancement_extensions(request)
        ),
    }


@router.post("/backfill-enhancement")
def post_backfill_enhancement(request: Request) -> dict:
    """Flag indexed image/PDF rows for advanced-OCR enhancement."""
    queue = _get_queue(request)
    flagged = queue.backfill_enhancement_pending(_get_enhancement_extensions(request))
    return {"flagged": flagged}


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


@router.get("/status/{node_id}")
def get_node_status(node_id: str, request: Request) -> dict:
    """Per-node status — used by the Inspector panel."""
    queue = _get_queue(request)
    job = queue.get(node_id)
    if job is None:
        return {
            "node_id": node_id,
            "state": "unknown",
            "indexed_at": None,
            "error": None,
            "attempts": 0,
        }
    return {
        "node_id": job.node_id,
        "state": job.state.value,
        "indexed_at": job.indexed_at.isoformat() if job.indexed_at else None,
        "error": job.last_error,
        "attempts": job.attempts,
    }


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
    artifact_chunks, artifact_assets = _extract_artifact_content(node_id, request)
    if artifact_chunks:
        joined = "\n\n".join(
            c["text"] for c in artifact_chunks if c["text"].strip()
        )
        return {
            "node_id": node_id,
            "kind": "file",
            "chunks": artifact_chunks,
            "joined": joined,
            "assets": artifact_assets,
        }

    store = _get_store(request)
    if store is None:
        return {
            "node_id": node_id,
            "kind": None,
            "chunks": [],
            "joined": "",
            "assets": {},
        }
    rows = store.scan(node_id)
    rows_sorted = sorted(rows, key=_chunk_index_key)
    chunks = []
    for row in rows_sorted:
        role = role_or_default(row)
        if role == "metadata":
            continue
        chunks.append(
            {
                "id": row.get("id"),
                "role": role,
                "text": row.get("text") or "",
            }
        )
    joined = "\n\n".join(c["text"] for c in chunks if c["text"].strip())
    kind = rows_sorted[0].get("kind") if rows_sorted else None
    return {
        "node_id": node_id,
        "kind": kind,
        "chunks": chunks,
        "joined": joined,
        "assets": {},
    }


def _extract_artifact_content(
    node_id: str,
    request: Request,
) -> tuple[list[dict], dict[str, str]]:
    artifacts = read_image_preview_artifacts(_get_extract_dir(request), node_id)
    chunks: list[dict] = []
    assets: dict[str, str] = {}
    for artifact in artifacts:
        chunks.append(
            {
                "id": f"{node_id}:extract:{artifact.kind}",
                "role": artifact.role,
                "text": artifact.text,
            }
        )
        assets.update(
            {source: str(path) for source, path in artifact.assets.items()}
        )
    return chunks, assets


def _chunk_index_key(row: dict) -> tuple[int, int, str]:
    """Sort key for chunk rows: ``(role_rank, chunk_index, id)``.

    Body chunks (rank 0) sort before voice transcript chunks (rank 1)
    and summary chunks (rank 2); within
    each role, the integer chunk-index suffix gives stable order so
    a 12-chunk document doesn't end up as ``[0, 1, 10, 11, 2, ...]``
    lexicographically. The role column is the primary discriminator
    rather than parsing the id, so a node id that happens to end in
    ``:summary`` cannot be misclassified.

    The trailing ``id`` tiebreaker keeps order deterministic when
    multiple rows fall back to ``idx=0`` (legacy or non-conforming
    ids whose suffix doesn't parse as an integer).
    """
    chunk_id = row.get("id") or ""
    _, _, suffix = chunk_id.rpartition(":")
    try:
        idx = int(suffix)
    except ValueError:
        idx = 0
    role = role_or_default(row)
    role_rank = {
        "body": 0,
        "voice_transcript": 1,
        "summary": 2,
        "metadata": 3,
    }
    rank = role_rank.get(role, 0)
    return (rank, idx, chunk_id)


@router.get("/changes")
def get_index_changes(
    request: Request, since: int = 0, limit: int = 1000
) -> dict:
    """Per-node state transitions newer than ``since``, oldest first.

    Used by Rust to mirror the sidecar's ``state`` field into the
    ``cognios.db`` ``nodes.state`` column without polling the full
    snapshot. Cost is proportional to the change rate, not the corpus
    size — a 100k-file workspace at idle returns an empty list every
    poll, while the snapshot endpoint returns 100k entries each time.

    Response shape::

        {
          "transitions": [
            {"node_id": "...", "state": "indexed",
             "indexed_at": "2026-05-03T...", "error": null,
             "transition_seq": 42},
            ...
          ],
          "next_seq": 42
        }

    ``next_seq`` is the largest ``transition_seq`` returned. The
    caller advances its cursor to this value so the next poll picks
    up from the next transition. ``next_seq=0`` (alongside an empty
    ``transitions`` list) means no new transitions since ``since``;
    the cursor stays put.

    ``limit`` defaults to 1000 and is capped server-side at 10k.
    """
    queue = _get_queue(request)
    transitions, next_seq = queue.changes_since(since=since, limit=limit)
    return {"transitions": transitions, "next_seq": next_seq}


@router.get("/snapshot")
def get_index_snapshot(request: Request) -> dict:
    """Per-node ``(state, modified_at)`` summary the Rust resync uses
    to compute the diff against ``cognios.db``.

    Returns one entry per node currently tracked by the queue. The
    payload is intentionally lean — no paths, no error strings, no
    indexed_at. Rust's diff only needs ``state`` (to detect "not
    indexed yet") and ``modified_at`` (to detect "cognios has newer
    content").
    """
    queue = _get_queue(request)
    return {"nodes": queue.snapshot()}
