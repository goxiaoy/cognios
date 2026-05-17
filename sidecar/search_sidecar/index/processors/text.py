"""Text / markdown processor.

Reads the file at ``IndexingJob.absolute_content_path``, splits it
into plain-text chunks of bounded length via :mod:`..chunking`,
embeds each chunk, and upserts the resulting :class:`NodeChunk`s
into the lancedb store. Voice notes also index their sibling
``voice-notes/<node_id>/transcript.md`` file as ``role="voice_transcript"``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ...storage import LanceDBStore, NodeChunk
from ..chunking import chunk_text
from ..embedder import Embedder
from ..queue import IndexingJob

VOICE_TRANSCRIPT_ROLE = "voice_transcript"
TRANSCRIPT_START = "<!-- voice-note:transcript:start -->"
TRANSCRIPT_END = "<!-- voice-note:transcript:end -->"


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
        raw_text = path.read_text(encoding="utf-8", errors="replace")
        body_text, legacy_transcript = (
            _strip_legacy_voice_note_transcript(raw_text)
            if job.kind == "note"
            else (raw_text, "")
        )
        written = self._replace_text_role(
            job,
            body_text,
            role="body",
            id_prefix=None,
        )

        if job.kind == "note":
            transcript_path = _voice_note_transcript_path(path, job.node_id)
            transcript_text = (
                transcript_path.read_text(encoding="utf-8", errors="replace")
                if transcript_path.is_file()
                else legacy_transcript
            )
            written += self._replace_text_role(
                job,
                transcript_text,
                role=VOICE_TRANSCRIPT_ROLE,
                id_prefix=VOICE_TRANSCRIPT_ROLE,
            )

        return written

    def _replace_text_role(
        self,
        job: IndexingJob,
        text: str,
        *,
        role: str,
        id_prefix: str | None,
    ) -> int:
        chunks = chunk_text(text)
        if not chunks:
            self._store.replace_chunks_by_role(job.node_id, role, [])
            return 0
        vectors = self._embedder.embed(chunks)
        if len(vectors) != len(chunks):
            raise ValueError(
                f"embedder returned {len(vectors)} vectors for {len(chunks)} chunks"
            )

        now = datetime.now(timezone.utc)
        id_stem = f"{job.node_id}:{id_prefix}" if id_prefix else job.node_id
        rows = [
            NodeChunk(
                id=f"{id_stem}:{i}",
                node_id=job.node_id,
                kind=job.kind,
                name=job.name,
                text=chunk,
                vector=vec,
                mount_id=job.mount_id,
                created_at=job.created_at,
                modified_at=job.modified_at or now,
                role=role,
                content_version=job.content_version,
            )
            for i, (chunk, vec) in enumerate(zip(chunks, vectors))
        ]
        return self._store.replace_chunks_by_role(job.node_id, role, rows)


def _voice_note_transcript_path(note_path: Path, node_id: str) -> Path:
    return note_path.parent.parent / "voice-notes" / node_id / "transcript.md"


def _strip_legacy_voice_note_transcript(text: str) -> tuple[str, str]:
    start_index = text.find(TRANSCRIPT_START)
    if start_index == -1:
        return text, ""
    content_start = start_index + len(TRANSCRIPT_START)
    relative_end_index = text[content_start:].find(TRANSCRIPT_END)
    if relative_end_index == -1:
        return text, ""

    end_index = content_start + relative_end_index
    transcript = text[content_start:end_index].strip()
    remove_start = start_index
    heading_index = text[:start_index].rfind("## Transcript")
    if heading_index != -1 and text[heading_index + len("## Transcript"):start_index].strip() == "":
        remove_start = heading_index
    remove_end = end_index + len(TRANSCRIPT_END)
    while remove_end < len(text) and text[remove_end].isspace():
        remove_end += 1

    before = text[:remove_start].rstrip()
    after = text[remove_end:].lstrip()
    if before and after:
        body = f"{before}\n\n{after}"
    elif before:
        body = f"{before}\n"
    elif after:
        body = f"{after}\n"
    else:
        body = ""

    if transcript in {"", "Transcription pending."}:
        transcript = ""
    return body, transcript
