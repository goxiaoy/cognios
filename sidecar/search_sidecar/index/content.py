"""Shared indexed-content reader for route previews and Chat tools."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..storage import LanceDBStore, role_or_default
from .extract_artifacts import read_image_preview_artifacts


@dataclass(frozen=True)
class NodeContentResult:
    node_id: str
    kind: str | None
    chunks: list[dict]
    joined: str
    assets: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "node_id": self.node_id,
            "kind": self.kind,
            "chunks": self.chunks,
            "joined": self.joined,
            "assets": self.assets,
        }


@dataclass(frozen=True)
class ScopeNode:
    node_id: str
    kind: str | None
    title: str


class NodeContentReader:
    def __init__(
        self,
        *,
        store: LanceDBStore | None,
        extract_dir: Path | None = None,
    ) -> None:
        self._store = store
        self._extract_dir = extract_dir

    def read(self, node_id: str) -> NodeContentResult:
        artifact_chunks, artifact_assets = self._extract_artifact_content(node_id)
        if artifact_chunks:
            joined = "\n\n".join(
                c["text"] for c in artifact_chunks if c["text"].strip()
            )
            return NodeContentResult(
                node_id=node_id,
                kind="file",
                chunks=artifact_chunks,
                joined=joined,
                assets=artifact_assets,
            )

        if self._store is None:
            return NodeContentResult(
                node_id=node_id,
                kind=None,
                chunks=[],
                joined="",
                assets={},
            )

        rows = self._store.scan(node_id)
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
        return NodeContentResult(
            node_id=node_id,
            kind=kind,
            chunks=chunks,
            joined=joined,
            assets={},
        )

    def list_mount_nodes(self, mount_id: str, *, limit: int = 100) -> list[ScopeNode]:
        if self._store is None:
            return []
        rows = self._store.scan_mount_nodes(
            mount_id,
            limit=limit,
            kinds={"note", "file", "url"},
        )
        return [
            ScopeNode(
                node_id=str(row.get("node_id") or ""),
                kind=row.get("kind") if isinstance(row.get("kind"), str) else None,
                title=str(row.get("name") or row.get("node_id") or ""),
            )
            for row in rows
            if row.get("node_id")
        ]

    def _extract_artifact_content(self, node_id: str) -> tuple[list[dict], dict[str, str]]:
        artifacts = read_image_preview_artifacts(self._extract_dir, node_id)
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
