"""Shared indexing job DTOs used by direct sidecar processors."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class JobState(str, Enum):
    INDEXING = "indexing"
    INDEXED = "indexed"
    ERROR = "error"


@dataclass
class IndexingJob:
    node_id: str
    kind: str
    name: str
    absolute_content_path: str | None
    mount_id: str | None
    state: JobState
    enqueued_at: datetime
    indexed_at: datetime | None
    last_error: str | None
    attempts: int
    created_at: datetime
    modified_at: datetime
    content_version: str | None = None
