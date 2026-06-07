"""Search metadata chunks.

Content processors index file bodies, OCR, captions, and cached URL
text. This module adds a separate, lightweight row for node metadata
so names and container paths participate in search without forcing a
content re-index on rename or startup resync.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

from ..storage import EMBEDDING_DIMENSION, LanceDBStore, NodeChunk
from .embedder import Embedder
from .job import IndexingJob

LOG = logging.getLogger("search_sidecar.index.metadata")
METADATA_ROLE = "metadata"


def replace_metadata_chunk_for_job(
    store: LanceDBStore,
    embedder: Embedder | None,
    job: IndexingJob,
) -> int:
    return replace_metadata_chunk(
        store,
        embedder,
        node_id=job.node_id,
        kind=job.kind,
        name=job.name,
        absolute_content_path=job.absolute_content_path,
        mount_id=job.mount_id,
        created_at=job.created_at,
        modified_at=job.modified_at,
        content_version=job.content_version,
    )


def replace_metadata_chunk(
    store: LanceDBStore,
    embedder: Embedder | None,
    *,
    node_id: str,
    kind: str,
    name: str,
    absolute_content_path: str | None = None,
    mount_id: str | None = None,
    created_at: datetime | None = None,
    modified_at: datetime | None = None,
    content_version: str | None = None,
) -> int:
    text = metadata_text(
        kind=kind,
        name=name,
        absolute_content_path=absolute_content_path,
    )
    if not text:
        return store.replace_chunks_by_role(node_id, METADATA_ROLE, [])

    now = datetime.now(timezone.utc)
    chunk = NodeChunk(
        id=f"{node_id}:metadata:0",
        node_id=node_id,
        kind=kind,
        name=name,
        text=text,
        vector=_embed_metadata(embedder, text),
        mount_id=mount_id,
        created_at=created_at or now,
        modified_at=modified_at or now,
        role=METADATA_ROLE,
        content_version=content_version,
    )
    return store.replace_chunks_by_role(node_id, METADATA_ROLE, [chunk])


def metadata_text(
    *,
    kind: str,
    name: str,
    absolute_content_path: str | None = None,
) -> str:
    parts: list[str] = []
    _append_unique(parts, name)
    if absolute_content_path:
        path = Path(absolute_content_path)
        _append_unique(parts, path.name)
        _append_unique(parts, str(path))
    if kind in {"folder", "mount"}:
        _append_unique(parts, kind)
    return "\n".join(parts)


def _append_unique(parts: list[str], value: str | None) -> None:
    value = (value or "").strip()
    if value and value not in parts:
        parts.append(value)


def _embed_metadata(embedder: Embedder | None, text: str) -> list[float]:
    if embedder is None:
        return [0.0] * EMBEDDING_DIMENSION
    try:
        vectors = embedder.embed([text])
    except Exception as err:
        LOG.warning("metadata embed failed; using zero vector: %s", err)
        return [0.0] * EMBEDDING_DIMENSION
    if len(vectors) != 1 or len(vectors[0]) != EMBEDDING_DIMENSION:
        LOG.warning("metadata embed returned invalid shape; using zero vector")
        return [0.0] * EMBEDDING_DIMENSION
    return vectors[0]
