"""Re-embed sweep: upgrade stub-vector chunks to real embeddings.

A user's first session indexes content while no semantic embedder is
loaded — every chunk lands in lancedb with a zero vector. Once the
real :class:`GteEmbedder` is wired (typically the next sidecar boot
after ``uv sync --extra embedding`` + a model download), the existing
chunks would silently stay degraded: the FTS path still works, but
the vector path returns nonsense for them.

This module's :func:`reembed_stale_chunks` walks the lancedb table,
finds every chunk whose vector is all zeros, re-runs the embedder on
the chunk's stored ``text``, and writes the new vector back. It runs
in batches so memory stays bounded even on large workspaces.

The sweep is launched once per sidecar boot from
:mod:`search_sidecar.lifecycle` whenever the selected embedder
advertises ``is_semantic=True``. Concurrent indexing during the
sweep is safe — new chunks land with real vectors so they don't
appear in the stale set.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..index.embedder import Embedder
    from ..storage import LanceDBStore

LOG = logging.getLogger("search_sidecar.embeddings.reembed")

DEFAULT_BATCH_SIZE = 32


@dataclass(frozen=True)
class ReembedSummary:
    """What the sweep did. Returned to callers so the lifecycle log
    line can report concrete numbers."""

    examined: int
    updated: int
    skipped: int


def reembed_stale_chunks(
    store: "LanceDBStore",
    embedder: "Embedder",
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> ReembedSummary:
    """Re-embed every chunk currently sitting on a stub (zero) vector.

    Returns a summary describing how many rows were examined, updated,
    and skipped (e.g., chunks whose ``text`` is empty — a real
    embedder would refuse to embed those, so we leave them alone).

    Failures during embedding for a single batch are logged and the
    batch is skipped; the sweep continues with the next batch. This
    keeps a transient model fault from killing the whole pass.
    """
    if not embedder.is_semantic:
        LOG.debug("re-embed sweep skipped: embedder is not semantic")
        return ReembedSummary(examined=0, updated=0, skipped=0)

    stale_rows = store.find_stale_chunks()
    if not stale_rows:
        return ReembedSummary(examined=0, updated=0, skipped=0)

    LOG.info(
        "re-embed sweep starting: %d stale chunks across %d nodes",
        len(stale_rows),
        len({r.get("node_id") for r in stale_rows if r.get("node_id")}),
    )

    examined = 0
    updated = 0
    skipped = 0
    for batch_start in range(0, len(stale_rows), batch_size):
        batch = stale_rows[batch_start : batch_start + batch_size]
        embedable: list[dict] = []
        for row in batch:
            text = row.get("text") or ""
            if not text.strip():
                skipped += 1
                continue
            embedable.append(row)
        examined += len(batch)
        if not embedable:
            continue
        try:
            vectors = embedder.embed([r["text"] for r in embedable])
        except Exception as err:
            LOG.warning(
                "re-embed batch %d-%d failed: %s. Skipping.",
                batch_start,
                batch_start + len(batch),
                err,
            )
            skipped += len(embedable)
            continue
        if len(vectors) != len(embedable):
            LOG.warning(
                "embedder returned %d vectors for %d inputs; skipping batch",
                len(vectors),
                len(embedable),
            )
            skipped += len(embedable)
            continue
        new_rows: list[dict] = []
        for row, vec in zip(embedable, vectors):
            if len(vec) != embedder.dimension:
                LOG.warning(
                    "embedder returned %d-dim vector for chunk %s; "
                    "skipping (expected %d)",
                    len(vec),
                    row.get("id"),
                    embedder.dimension,
                )
                skipped += 1
                continue
            new_rows.append({**row, "vector": vec})
        if new_rows:
            try:
                store.replace_rows(new_rows)
            except Exception as err:
                LOG.warning(
                    "lancedb replace_rows failed for batch %d-%d: %s",
                    batch_start,
                    batch_start + len(batch),
                    err,
                )
                skipped += len(new_rows)
                continue
            updated += len(new_rows)

    LOG.info(
        "re-embed sweep done: examined=%d updated=%d skipped=%d",
        examined,
        updated,
        skipped,
    )
    return ReembedSummary(
        examined=examined, updated=updated, skipped=skipped
    )
