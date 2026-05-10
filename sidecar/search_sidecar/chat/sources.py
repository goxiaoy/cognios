"""Chat source and cluster DTOs."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

SourceKind = Literal["workspace", "web"]
ClusterStatus = Literal["candidate", "accepted", "excluded", "suggested"]


@dataclass(frozen=True)
class ChatSource:
    source_id: str
    source_kind: SourceKind
    title: str
    snippet: str
    citation: str
    path: str | None = None
    score: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class SourceCluster:
    cluster_id: str
    title: str
    source_kind: Literal["workspace", "web", "mixed"]
    status: ClusterStatus
    summary: str
    score: float
    sources: list[ChatSource] = field(default_factory=list)

    def to_dict(self) -> dict:
        body = asdict(self)
        body["sources"] = [source.to_dict() for source in self.sources]
        return body
