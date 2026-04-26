"""SQLite-backed persistent indexing queue (``queue.db``).

Schema::

    CREATE TABLE jobs (
      node_id               TEXT PRIMARY KEY,
      kind                  TEXT NOT NULL,
      name                  TEXT NOT NULL,
      absolute_content_path TEXT,        -- nullable for kinds without a file
      mount_id              TEXT,
      state                 TEXT NOT NULL,  -- pending | indexing | indexed | error
      enqueued_at           TEXT NOT NULL,
      indexed_at            TEXT,
      last_error            TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL,
      modified_at           TEXT NOT NULL
    );
    CREATE INDEX idx_jobs_state ON jobs(state);

Concurrency model: a single :class:`IndexingQueue` is shared by the
FastAPI request handlers (which call :meth:`enqueue`) and the runner
worker (which calls :meth:`claim_next` / :meth:`mark_indexed` /
:meth:`mark_error`). All access is funnelled through one
``sqlite3.Connection`` per process; SQLite serialises writes via WAL,
and the connection's per-statement lock is sufficient for the small
write throughput of an indexing queue.

Crash safety:

- ``PRAGMA journal_mode=WAL`` + ``synchronous=NORMAL`` is the
  durability/performance baseline.
- ``PRAGMA quick_check`` runs at open; on corruption (e.g. from an
  unclean shutdown), the file is renamed to ``queue.db.corrupt-<ts>``,
  the schema is recreated empty, and the caller is told to trigger a
  fresh resync from Rust (Unit 7's responsibility).
- Any rows in state ``indexing`` at open are reset to ``pending`` —
  mirrors the existing url-job ``requeue_stale_jobs`` pattern.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

LOG = logging.getLogger("search_sidecar.index.queue")


class JobState(str, Enum):
    PENDING = "pending"
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


class CorruptQueueDatabase(RuntimeError):
    """Raised when ``PRAGMA quick_check`` fails at open and the
    corrupt file has been renamed aside."""


class IndexingQueue:
    """Persistent indexing queue.

    Construct via :func:`open_queue` to get the WAL + integrity-check
    + stale-row-reset behaviour for free.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._conn.row_factory = sqlite3.Row

    # ----- write side ---------------------------------------------------

    def enqueue(
        self,
        *,
        node_id: str,
        kind: str,
        name: str,
        absolute_content_path: str | None = None,
        mount_id: str | None = None,
        created_at: datetime | None = None,
        modified_at: datetime | None = None,
    ) -> None:
        """Insert or revive a job for ``node_id``.

        If a row already exists (any state), it is reset to ``pending``
        so the runner re-processes it. ``attempts`` is preserved; the
        caller can use it to detect runaway retries.
        """
        now_str = _now_iso()
        ca = (created_at or _now()).astimezone(timezone.utc).isoformat()
        ma = (modified_at or _now()).astimezone(timezone.utc).isoformat()
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO jobs (
                    node_id, kind, name, absolute_content_path, mount_id,
                    state, enqueued_at, attempts, created_at, modified_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                    kind = excluded.kind,
                    name = excluded.name,
                    absolute_content_path = excluded.absolute_content_path,
                    mount_id = excluded.mount_id,
                    state = 'pending',
                    enqueued_at = excluded.enqueued_at,
                    last_error = NULL,
                    indexed_at = NULL,
                    modified_at = excluded.modified_at
                """,
                (
                    node_id,
                    kind,
                    name,
                    absolute_content_path,
                    mount_id,
                    JobState.PENDING.value,
                    now_str,
                    ca,
                    ma,
                ),
            )

    def remove(self, node_id: str) -> bool:
        """Drop the job row for ``node_id`` (used on node deletion).

        Returns True if a row was removed.
        """
        with self._conn:
            cur = self._conn.execute(
                "DELETE FROM jobs WHERE node_id = ?", (node_id,)
            )
        return cur.rowcount > 0

    def claim_next(self) -> Optional[IndexingJob]:
        """Atomically pick the oldest pending job and mark it ``indexing``.

        Returns ``None`` if the queue has no pending work.
        """
        with self._conn:
            row = self._conn.execute(
                """
                SELECT * FROM jobs
                WHERE state = ?
                ORDER BY enqueued_at ASC
                LIMIT 1
                """,
                (JobState.PENDING.value,),
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                """
                UPDATE jobs SET state = ?, attempts = attempts + 1
                WHERE node_id = ?
                """,
                (JobState.INDEXING.value, row["node_id"]),
            )
        # The pre-UPDATE row was captured above; reflect the
        # post-UPDATE state in the returned job so callers see the
        # incremented attempt count.
        merged = {**dict(row), "state": JobState.INDEXING.value}
        merged["attempts"] = (merged.get("attempts") or 0) + 1
        return _row_to_job(merged)

    def mark_indexed(self, node_id: str) -> None:
        with self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET state = ?, indexed_at = ?, last_error = NULL
                WHERE node_id = ?
                """,
                (JobState.INDEXED.value, _now_iso(), node_id),
            )

    def mark_error(self, node_id: str, message: str) -> None:
        # Cap last_error at 1 KB (security FINDING-003).
        truncated = message[:1024]
        with self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET state = ?, last_error = ?
                WHERE node_id = ?
                """,
                (JobState.ERROR.value, truncated, node_id),
            )

    # ----- read side ----------------------------------------------------

    def get(self, node_id: str) -> Optional[IndexingJob]:
        row = self._conn.execute(
            "SELECT * FROM jobs WHERE node_id = ?", (node_id,)
        ).fetchone()
        return _row_to_job(dict(row)) if row else None

    def queue_depth(self) -> int:
        return self._conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE state = ?",
            (JobState.PENDING.value,),
        ).fetchone()[0]

    def in_flight_node_ids(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT node_id FROM jobs WHERE state = ?",
            (JobState.INDEXING.value,),
        ).fetchall()
        return [r["node_id"] for r in rows]

    def list_node_ids(self) -> set[str]:
        rows = self._conn.execute("SELECT node_id FROM jobs").fetchall()
        return {r["node_id"] for r in rows}

    # ----- lifecycle ----------------------------------------------------

    def reset_stale_indexing(self) -> int:
        """Reset rows stuck in ``indexing`` to ``pending``.

        Called once at queue open. Mirrors the existing url-job pattern.
        Returns the number of rows reset.
        """
        with self._conn:
            cur = self._conn.execute(
                """
                UPDATE jobs SET state = ?, last_error = NULL
                WHERE state = ?
                """,
                (JobState.PENDING.value, JobState.INDEXING.value),
            )
        return cur.rowcount

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass


# ----- module-level constructor + helpers --------------------------------


def open_queue(path: Path) -> IndexingQueue:
    """Open ``queue.db`` (creating it if absent) with WAL +
    integrity-check + stale-row reset.

    On corruption, renames the file to ``queue.db.corrupt-<unix-ts>``
    and creates a fresh schema. The caller (lifecycle bootstrap) is
    expected to log this and rely on the resync ping (Unit 7) to
    rebuild from Rust's authoritative ``nodes`` table.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        return _open_or_create(path)
    except sqlite3.DatabaseError as err:
        # Either the file is not a SQLite db or it is and quick_check
        # fails. In both cases the recovery is the same: rename aside
        # and start fresh.
        backup = path.with_suffix(path.suffix + f".corrupt-{int(time.time())}")
        path.rename(backup)
        LOG.warning(
            "queue.db unreadable (%s); renamed to %s and recreating",
            err,
            backup,
        )
        return _open_or_create(path)


def _open_or_create(path: Path) -> IndexingQueue:
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise sqlite3.DatabaseError(f"quick_check returned {integrity!r}")
        _ensure_schema(conn)
    except sqlite3.DatabaseError:
        conn.close()
        raise
    queue = IndexingQueue(conn)
    reset = queue.reset_stale_indexing()
    if reset:
        LOG.info("queue: reset %d stale 'indexing' rows to 'pending'", reset)
    return queue


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS jobs (
            node_id               TEXT PRIMARY KEY,
            kind                  TEXT NOT NULL,
            name                  TEXT NOT NULL,
            absolute_content_path TEXT,
            mount_id              TEXT,
            state                 TEXT NOT NULL,
            enqueued_at           TEXT NOT NULL,
            indexed_at            TEXT,
            last_error            TEXT,
            attempts              INTEGER NOT NULL DEFAULT 0,
            created_at            TEXT NOT NULL,
            modified_at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
        """
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _row_to_job(row: dict) -> IndexingJob:
    return IndexingJob(
        node_id=row["node_id"],
        kind=row["kind"],
        name=row["name"],
        absolute_content_path=row.get("absolute_content_path"),
        mount_id=row.get("mount_id"),
        state=JobState(row["state"]),
        enqueued_at=_parse(row["enqueued_at"]),
        indexed_at=_parse(row.get("indexed_at")),
        last_error=row.get("last_error"),
        attempts=int(row.get("attempts") or 0),
        created_at=_parse(row["created_at"]),
        modified_at=_parse(row["modified_at"]),
    )


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)
