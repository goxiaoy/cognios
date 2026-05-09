"""Text / markdown processor.

Reads the file at ``IndexingJob.absolute_content_path``, splits it
into plain-text chunks of bounded length via :mod:`..chunking`,
embeds each chunk, and upserts the resulting :class:`NodeChunk`s
into the lancedb store.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..queue import IndexingJob


class TextProcessor:
    """Processes ``kind="note"`` and text-like ``kind="file"`` nodes.

    The runner instantiates one of these per worker thread. The
    embedder is injected so tests can pass :class:`StubEmbedder` and
    production can pass the real ONNX-backed embedder once it ships.
    """

    KINDS = ("note", "file")
    EXTENSIONS = (".md", ".mdx", ".txt", ".markdown")

    def __init__(self, store: LanceDBStore, embedder: Embedder) -> None:
        self._store = store
        self._embedder = embedder

    def can_handle(self, job: IndexingJob) -> bool:
        if job.kind not in self.KINDS:
            return False
        if job.absolute_content_path is None:
            return False
        suffix = Path(job.absolute_content_path).suffix.lower()
        return suffix in self.EXTENSIONS

    def process(self, job: IndexingJob) -> int:
        """Read, chunk, embed, upsert. Returns number of chunks written."""
        path = Path(job.absolute_content_path or "")
        if not path.is_file():
            raise FileNotFoundError(f"missing file: {path}")
        text = path.read_text(encoding="utf-8", errors="replace")
        chunks = chunk_text(text)

        # Always replace the node's previous chunks — the simplest way
        # to keep the store consistent on re-index of an existing node.
        self._store.delete_by_node_id(job.node_id)

        if not chunks:
            return 0

        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )

        now = datetime.now(timezone.utc)
        rows = [
            NodeChunk(
                id=f"{job.node_id}:{i}",
                node_id=job.node_id,
                kind=job.kind,
                name=job.name,
                text=chunk,
                vector=vec,
                mount_id=job.mount_id,
                created_at=job.created_at,
                modified_at=job.modified_at or now,
                role="body",
                content_version=job.content_version,
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        self._store.upsert(rows)
        return len(rows)
