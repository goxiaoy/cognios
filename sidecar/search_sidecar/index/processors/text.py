"""Text / markdown processor.

Reads the file at ``IndexingJob.absolute_content_path``, splits it
into plain-text chunks of bounded length, embeds each chunk, and
upserts the resulting :class:`NodeChunk`s into the lancedb store.

Chunking strategy is the documented Unit-5 placeholder: split on
paragraph boundaries first, then on sentence boundaries inside a
paragraph if any single paragraph exceeds the size cap. This is
cheap and language-agnostic; a tokenizer-aware splitter is an
optimisation for v1b once we measure recall on real content.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from ...storage import LanceDBStore, NodeChunk
from ..embedder import Embedder
from ..queue import IndexingJob

# 512 unicode chars ≈ 100-150 tokens for English, fewer for Chinese.
# Safe inside gte-multilingual's 8192-token window.
MAX_CHUNK_CHARS = 512
PARAGRAPH_SEPARATORS = ("\n\n", "\r\n\r\n")
SENTENCE_TERMINATORS = (". ", "! ", "? ", "。", "！", "？")


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
        chunks = list(_chunk(text))

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
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        self._store.upsert(rows)
        return len(rows)


def _chunk(text: str) -> Sequence[str]:
    """Split ``text`` into chunks of at most :data:`MAX_CHUNK_CHARS`.

    Strategy:
    1. Split on paragraph boundaries (blank-line separators).
    2. If any paragraph is still too long, split that paragraph on
       sentence terminators, packing sentences greedily into the cap.
    3. If any single sentence is still too long, hard-break at
       :data:`MAX_CHUNK_CHARS`.
    """
    if not text.strip():
        return []
    paragraphs = _split_paragraphs(text)
    out: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= MAX_CHUNK_CHARS:
            out.append(para)
            continue
        out.extend(_split_long_paragraph(para))
    return out


def _split_paragraphs(text: str) -> list[str]:
    parts: list[str] = [text]
    for sep in PARAGRAPH_SEPARATORS:
        next_parts: list[str] = []
        for piece in parts:
            next_parts.extend(piece.split(sep))
        parts = next_parts
    return parts


def _split_long_paragraph(paragraph: str) -> list[str]:
    sentences = _split_sentences(paragraph)
    out: list[str] = []
    buf = ""
    for sentence in sentences:
        # Hard-break sentences longer than the cap.
        while len(sentence) > MAX_CHUNK_CHARS:
            head, sentence = sentence[:MAX_CHUNK_CHARS], sentence[MAX_CHUNK_CHARS:]
            if buf:
                out.append(buf)
                buf = ""
            out.append(head)
        if not sentence:
            continue
        if not buf:
            buf = sentence
        elif len(buf) + 1 + len(sentence) <= MAX_CHUNK_CHARS:
            buf = f"{buf} {sentence}"
        else:
            out.append(buf)
            buf = sentence
    if buf:
        out.append(buf)
    return out


def _split_sentences(paragraph: str) -> list[str]:
    """Greedy split on a small set of sentence terminators."""
    sentences: list[str] = []
    buf = ""
    i = 0
    while i < len(paragraph):
        char = paragraph[i]
        # Look ahead for a multi-char terminator like ". "
        match = None
        for term in SENTENCE_TERMINATORS:
            if paragraph.startswith(term, i):
                match = term
                break
        if match is not None:
            buf += match
            sentences.append(buf.strip())
            buf = ""
            i += len(match)
            continue
        buf += char
        i += 1
    if buf.strip():
        sentences.append(buf.strip())
    return sentences
