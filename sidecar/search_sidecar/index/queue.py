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
      modified_at           TEXT NOT NULL,
      content_version       TEXT,
      indexed_content_version TEXT,
      transition_seq        INTEGER NOT NULL DEFAULT 0,
      enhancement_pending   INTEGER NOT NULL DEFAULT 0,
      enhancement_attempts  INTEGER NOT NULL DEFAULT 0,
      enhancement_failed    INTEGER NOT NULL DEFAULT 0,
      enhancement_completed_at TEXT
    );
    CREATE INDEX idx_jobs_state ON jobs(state);
    CREATE INDEX idx_jobs_transition_seq ON jobs(transition_seq);

The ``transition_seq`` column is bumped to a fresh monotonic value
on every state mutation. Rust polls ``GET /index/changes?since=<n>``
to learn which nodes' states have changed since its last poll —
the cost is proportional to the change rate, not the corpus size,
which is the property the snapshot endpoint lacks at scale.

The ``enhancement_*`` columns power the two-pass OCR enhancement flow.
The basic pass runs first and lands chunks fast; the
slow advanced OCR pass (PP-StructureV3) runs as a background
enhancement that replaces only the body chunks. ``enhancement_pending``
is the runner's claim filter; ``enhancement_attempts`` caps transient
retries; ``enhancement_completed_at`` records that advanced OCR already
ran for the current indexed file version so startup backfill does not
replay the image on every sidecar restart. ``enhancement_failed`` is a
sticky terminal sentinel that prevents the cap-exhausted row from being
re-flagged by the next backfill (so the diagnostics counter can
distinguish "enhanced" from "gave up"). Only ``enqueue`` (file mod)
and the user-triggered Reindex action clear the completed/failed bits.

Concurrency model: a single :class:`IndexingQueue` is shared by the
FastAPI request handlers (which call :meth:`enqueue`) and the runner
worker (which calls :meth:`claim_next` / :meth:`mark_indexed` /
:meth:`mark_error`). The shared ``sqlite3.Connection`` is opened with
``check_same_thread=False`` so it can move between threads, but
CPython's sqlite3 module does NOT serialise ``connection.execute``
calls across threads — concurrent execute-then-fetchone chains can
race and surface as ``Cursor.fetchone()`` returning ``None`` on
``SELECT COUNT(*)`` even though the table has rows. To keep behavior
predictable, every public method funnels through ``self._lock`` (a
re-entrant lock so internal helpers can call other public methods
without deadlock). SQLite still does its own WAL serialisation under
us; the Python-side lock just makes the cursor lifecycle race-free.

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
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

from .migrations import run_migrations

LOG = logging.getLogger("search_sidecar.index.queue")


# Bounded retry for transient errors during the advanced-OCR
# enhancement pass (cloud rate limits, network blips, etc.). Once a
# row reaches this many transient failures, the runner promotes the
# failure to terminal and sets ``enhancement_failed=1``; the row is
# then ineligible for both ``claim_next_enhancement`` and the
# backfill IPC until the user triggers a reindex.
MAX_ENHANCEMENT_ATTEMPTS = 3


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
    content_version: str | None = None


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
        # Re-entrant so a method that delegates to another public
        # method (e.g. tests calling close after a failed open) doesn't
        # self-deadlock. See module docstring for why this is needed
        # despite SQLite's own WAL serialisation.
        self._lock = threading.RLock()

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
        force: bool = True,
    ) -> None:
        """Insert or revive a job for ``node_id``.

        If a row already exists, forced calls reset it to ``pending``
        so the runner re-processes it. Non-forced calls are used by
        startup resync; they are idempotent for same-version rows that
        are already pending, indexing, or indexed, avoiding a race
        where a stale resync rewinds an already-indexed live event.
        ``attempts`` is preserved; the caller can use it to detect
        runaway retries.

        The enhancement bookkeeping (``enhancement_pending``,
        ``enhancement_attempts``, ``enhancement_failed``,
        ``enhancement_completed_at``) is reset on every revive — a file
        modification or user-triggered reindex re-runs the full
        two-pass flow from scratch, including re-arming a previously
        completed or cap-exhausted row.
        """
        now_str = _now_iso()
        ca = (created_at or _now()).astimezone(timezone.utc).isoformat()
        ma = (modified_at or _now()).astimezone(timezone.utc).isoformat()
        content_version = _content_version(kind, absolute_content_path, ma)
        with self._lock, self._conn:
            if not force:
                row = self._conn.execute(
                    "SELECT state, content_version FROM jobs WHERE node_id = ?",
                    (node_id,),
                ).fetchone()
                if (
                    row is not None
                    and row["state"]
                    in {
                        JobState.PENDING.value,
                        JobState.INDEXING.value,
                        JobState.INDEXED.value,
                    }
                    and row["content_version"] == content_version
                ):
                    self._conn.execute(
                        """
                        UPDATE jobs
                        SET kind = ?, name = ?, absolute_content_path = ?,
                            mount_id = ?, created_at = ?, modified_at = ?,
                            content_version = ?
                        WHERE node_id = ?
                        """,
                        (
                            kind,
                            name,
                            absolute_content_path,
                            mount_id,
                            ca,
                            ma,
                            content_version,
                            node_id,
                        ),
                    )
                    return
            seq = self._next_transition_seq()
            self._conn.execute(
                """
                INSERT INTO jobs (
                    node_id, kind, name, absolute_content_path, mount_id,
                    state, enqueued_at, attempts, created_at, modified_at,
                    content_version, indexed_content_version,
                    transition_seq, enhancement_pending,
                    enhancement_attempts, enhancement_failed,
                    enhancement_completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, 0, 0, 0, NULL)
                ON CONFLICT(node_id) DO UPDATE SET
                    kind = excluded.kind,
                    name = excluded.name,
                    absolute_content_path = excluded.absolute_content_path,
                    mount_id = excluded.mount_id,
                    state = 'pending',
                    enqueued_at = excluded.enqueued_at,
                    last_error = NULL,
                    indexed_at = NULL,
                    modified_at = excluded.modified_at,
                    content_version = excluded.content_version,
                    indexed_content_version = NULL,
                    transition_seq = excluded.transition_seq,
                    enhancement_pending = 0,
                    enhancement_attempts = 0,
                    enhancement_failed = 0,
                    enhancement_completed_at = NULL
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
                    content_version,
                    seq,
                ),
            )

    def remove(self, node_id: str) -> bool:
        """Drop the job row for ``node_id`` (used on node deletion).

        Returns True if a row was removed.
        """
        with self._lock, self._conn:
            cur = self._conn.execute(
                "DELETE FROM jobs WHERE node_id = ?", (node_id,)
            )
        return cur.rowcount > 0

    def claim_next(self) -> Optional[IndexingJob]:
        """Atomically pick the oldest pending job and mark it ``indexing``.

        Returns ``None`` if the queue has no pending work.
        """
        with self._lock, self._conn:
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
            seq = self._next_transition_seq()
            self._conn.execute(
                """
                UPDATE jobs SET state = ?, attempts = attempts + 1,
                               transition_seq = ?
                WHERE node_id = ?
                """,
                (JobState.INDEXING.value, seq, row["node_id"]),
            )
        # The pre-UPDATE row was captured above; reflect the
        # post-UPDATE state in the returned job so callers see the
        # incremented attempt count.
        merged = {**dict(row), "state": JobState.INDEXING.value}
        merged["attempts"] = (merged.get("attempts") or 0) + 1
        return _row_to_job(merged)

    def mark_indexed(self, node_id: str) -> None:
        with self._lock, self._conn:
            seq = self._next_transition_seq()
            self._conn.execute(
                """
                UPDATE jobs
                SET state = ?, indexed_at = ?, last_error = NULL,
                    indexed_content_version = content_version,
                    transition_seq = ?
                WHERE node_id = ?
                """,
                (JobState.INDEXED.value, _now_iso(), seq, node_id),
            )

    def mark_error(self, node_id: str, message: str) -> None:
        # Cap last_error at 1 KB (security FINDING-003).
        truncated = message[:1024]
        with self._lock, self._conn:
            seq = self._next_transition_seq()
            self._conn.execute(
                """
                UPDATE jobs
                SET state = ?, last_error = ?, transition_seq = ?
                WHERE node_id = ?
                """,
                (JobState.ERROR.value, truncated, seq, node_id),
            )

    # ----- enhancement (two-pass image OCR) ----------------------------

    def claim_next_enhancement(
        self,
    ) -> tuple[IndexingJob, int] | None:
        """Pick the oldest indexed image that's flagged for enhancement.

        Filters: ``state='indexed' AND enhancement_pending=1 AND
        enhancement_failed=0 AND enhancement_attempts <
        MAX_ENHANCEMENT_ATTEMPTS``. Does NOT mutate state — the row
        stays ``indexed`` while the enhancement runs (the basic chunks
        are still there and still searchable). The caller passes the
        returned ``claim_seq`` (current ``transition_seq``) back into
        ``peek_transition_seq`` AFTER the lance write to detect a
        mid-flight re-enqueue.

        Returns ``None`` when no enhancement work is available.
        """
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM jobs
                WHERE state = ?
                  AND enhancement_pending = 1
                  AND enhancement_failed = 0
                  AND enhancement_attempts < ?
                ORDER BY indexed_at ASC
                LIMIT 1
                """,
                (JobState.INDEXED.value, MAX_ENHANCEMENT_ATTEMPTS),
            ).fetchone()
        if row is None:
            return None
        return _row_to_job(dict(row)), int(row["transition_seq"])

    def set_enhancement_pending(self, node_id: str) -> None:
        """Idempotent: flag a row for advanced-OCR enhancement.

        Refuses to flag rows that are terminally failed
        (``enhancement_failed=1``) or already completed for this file
        version — only ``enqueue`` (file mod) or the Reindex action
        clears those bits. This keeps a basic-pass
        completion handler from accidentally re-arming a row the
        runner has already finished or given up on.

        The basic pass calls this while the runner still has the row
        in ``state='indexing'``; ``claim_next_enhancement`` still
        requires ``state='indexed'`` so the row only becomes drainable
        after the runner records basic-pass success.
        """
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET enhancement_pending = 1
                WHERE node_id = ?
                  AND enhancement_failed = 0
                  AND enhancement_completed_at IS NULL
                """,
                (node_id,),
            )

    def clear_enhancement_pending(self, node_id: str) -> None:
        """Drop the enhancement flag (success or empty result).

        No-op for rows that are already cleared; safe to call after
        successful advanced OCR, including an empty-but-valid result.
        Does NOT touch ``enhancement_attempts`` or
        ``enhancement_failed`` — those are owned by their own helpers.
        """
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET enhancement_pending = 0,
                    enhancement_completed_at = COALESCE(enhancement_completed_at, ?)
                WHERE node_id = ?
                """,
                (_now_iso(), node_id),
            )

    def mark_enhancement_failed(self, node_id: str) -> None:
        """Sticky terminal failure: clears pending + sets failed.

        Distinguishes "tried and gave up" from "haven't tried yet" —
        the diagnostics counter and the backfill predicate both rely
        on this distinction. Cleared only by ``enqueue`` (which
        resets enhancement bookkeeping on revive).
        """
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET enhancement_pending = 0, enhancement_failed = 1
                WHERE node_id = ?
                """,
                (node_id,),
            )

    def bump_enhancement_attempts(self, node_id: str) -> int:
        """Increment ``enhancement_attempts`` after a transient error.

        Returns the new attempt count so the caller can decide whether
        to keep retrying or promote to terminal. Leaves
        ``enhancement_pending=1`` so the runner re-claims on the next
        tick (or after a sleep — caller's choice).
        """
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE jobs
                SET enhancement_attempts = enhancement_attempts + 1
                WHERE node_id = ?
                """,
                (node_id,),
            )
            row = self._conn.execute(
                "SELECT enhancement_attempts FROM jobs WHERE node_id = ?",
                (node_id,),
            ).fetchone()
        return int(row[0]) if row is not None else 0

    def peek_transition_seq(self, node_id: str) -> int | None:
        """Read the row's current ``transition_seq`` under the queue lock.

        Used by ``ImageProcessor.process_enhancement`` AFTER the lance
        write to detect a mid-flight re-enqueue (file modified between
        claim and commit). The lance store doesn't share this lock, so
        a re-check here is the only way to catch the race; the caller
        compares against the ``claim_seq`` returned by
        ``claim_next_enhancement``.

        Returns ``None`` when the row no longer exists (e.g., node was
        deleted mid-flight).
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT transition_seq FROM jobs WHERE node_id = ?",
                (node_id,),
            ).fetchone()
        return int(row[0]) if row is not None else None

    def matches_content_claim(
        self, node_id: str, content_version: str | None, transition_seq: int
    ) -> bool:
        """True when the row still matches a long-running worker's claim."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT content_version, transition_seq
                FROM jobs
                WHERE node_id = ?
                """,
                (node_id,),
            ).fetchone()
        return (
            row is not None
            and row["content_version"] == content_version
            and int(row["transition_seq"]) == int(transition_seq)
        )

    def clear_enhancement_pending_if_transition_seq(
        self, node_id: str, expected_seq: int
    ) -> bool:
        """Atomically clear pending only if ``transition_seq`` matches.

        Returns ``False`` when the row disappeared or was re-enqueued
        after enhancement claim. The caller must treat that as a stale
        enhancement write and clean up the store.
        """
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT transition_seq FROM jobs WHERE node_id = ?",
                (node_id,),
            ).fetchone()
            if row is None or int(row[0]) != expected_seq:
                return False
            self._conn.execute(
                """
                UPDATE jobs
                SET enhancement_pending = 0,
                    enhancement_completed_at = COALESCE(enhancement_completed_at, ?)
                WHERE node_id = ?
                """,
                (_now_iso(), node_id),
            )
            return True

    def backfill_enhancement_pending(self, file_extensions: tuple[str, ...]) -> int:
        """Idempotent: flag every eligible indexed OCR target for enhancement.

        Called from the Rust watcher on the local-bundle ready
        transition AND from the sidecar startup hook (cross-version
        upgrade case). ``file_extensions`` is a tuple of suffixes
        WITHOUT the leading dot (e.g. ``("png", "jpg", ...)``).

        Predicate excludes already-pending rows, already-completed rows,
        terminally-failed rows, and already-cap-exhausted rows. The
        exclusion of ``enhancement_completed_at IS NULL`` is
        load-bearing: without it, sidecar restart would replay every
        successfully enhanced target indefinitely. The exclusion of
        ``enhancement_failed=1`` is load-bearing: without it, a watcher
        re-trigger (e.g., sidecar restart) would replay every
        previously-given-up row indefinitely.

        Returns the number of rows newly flagged.
        """
        if not file_extensions:
            return 0
        # Build a parameterised LOWER(name) LIKE OR-chain. Doing the
        # extension match in SQL avoids loading the entire jobs table
        # into Python just to filter on suffixes.
        like_clauses = " OR ".join(
            ["LOWER(name) LIKE ?" for _ in file_extensions]
        )
        params: list[object] = [
            f"%.{ext.lower().lstrip('.')}" for ext in file_extensions
        ]
        params.append(JobState.INDEXED.value)
        params.append(MAX_ENHANCEMENT_ATTEMPTS)
        with self._lock, self._conn:
            cur = self._conn.execute(
                f"""
                UPDATE jobs
                SET enhancement_pending = 1
                WHERE kind = 'file'
                  AND ({like_clauses})
                  AND state = ?
                  AND enhancement_pending = 0
                  AND enhancement_completed_at IS NULL
                  AND enhancement_failed = 0
                  AND enhancement_attempts < ?
                """,
                params,
            )
            return cur.rowcount

    def count_enhancement_pending(self) -> int:
        """Backlog size (rows the runner can still pick up)."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT COUNT(*) FROM jobs
                WHERE state = ?
                  AND enhancement_pending = 1
                  AND enhancement_failed = 0
                """,
                (JobState.INDEXED.value,),
            ).fetchone()
        return int(row[0]) if row is not None else 0

    def count_enhancement_failed(self) -> int:
        """Terminal-failure tally (rows that gave up; not retried)."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT COUNT(*) FROM jobs
                WHERE state = ?
                  AND enhancement_failed = 1
                """,
                (JobState.INDEXED.value,),
            ).fetchone()
        return int(row[0]) if row is not None else 0

    def count_enhancement_eligible_total(
        self, file_extensions: tuple[str, ...]
    ) -> int:
        """Denominator for the diagnostics counter: indexed OCR targets.

        Mirrors the predicate of ``backfill_enhancement_pending`` minus
        the eligibility filters — every indexed target counts, including
        ones that are still pending and ones that terminally failed.
        ``file_extensions`` has the same shape (without leading dot)
        for symmetry with the backfill helper.
        """
        if not file_extensions:
            return 0
        like_clauses = " OR ".join(
            ["LOWER(name) LIKE ?" for _ in file_extensions]
        )
        params: list[object] = [
            f"%.{ext.lower().lstrip('.')}" for ext in file_extensions
        ]
        params.append(JobState.INDEXED.value)
        with self._lock:
            row = self._conn.execute(
                f"""
                SELECT COUNT(*) FROM jobs
                WHERE kind = 'file'
                  AND ({like_clauses})
                  AND state = ?
                """,
                params,
            ).fetchone()
        return int(row[0]) if row is not None else 0

    def _next_transition_seq(self) -> int:
        """Return ``MAX(transition_seq) + 1`` for the next state mutation.

        Caller must hold ``self._lock`` and be inside a write
        transaction so the read-then-write is race-free against
        concurrent mutations on other connections (we currently use
        a single connection but the lock + transaction are correct
        even if that ever changes).
        """
        row = self._conn.execute(
            "SELECT COALESCE(MAX(transition_seq), 0) + 1 FROM jobs"
        ).fetchone()
        return int(row[0])

    # ----- read side ----------------------------------------------------

    def get(self, node_id: str) -> Optional[IndexingJob]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM jobs WHERE node_id = ?", (node_id,)
            ).fetchone()
        return _row_to_job(dict(row)) if row else None

    def queue_depth(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE state = ?",
                (JobState.PENDING.value,),
            ).fetchone()
        # Belt-and-braces: ``SELECT COUNT(*)`` always returns one row,
        # but if some future schema or pragma surprise yields ``None``
        # we'd rather return zero than 500 the status endpoint.
        return int(row[0]) if row is not None else 0

    def in_flight_node_ids(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT node_id FROM jobs WHERE state = ?",
                (JobState.INDEXING.value,),
            ).fetchall()
        return [r["node_id"] for r in rows]

    def recent_indexed_counts(self, *, days: int = 28) -> list[dict[str, int | str]]:
        """Return day-level counts for recently indexed rows.

        This is intentionally based on ``indexed_at`` rather than VFS
        update timestamps so metadata-only changes do not inflate Home's
        activity graph.
        """
        capped_days = max(1, min(int(days), 366))
        local_tz = datetime.now().astimezone().tzinfo
        today = datetime.now().astimezone().date()
        start = today.toordinal() - capped_days + 1
        counts = {
            datetime.fromordinal(start + offset).date().isoformat(): 0
            for offset in range(capped_days)
        }
        cutoff = (
            datetime.fromordinal(start)
            .replace(tzinfo=local_tz)
            .astimezone(timezone.utc)
            .isoformat()
        )
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT indexed_at
                FROM jobs
                WHERE state = ?
                  AND indexed_at IS NOT NULL
                  AND indexed_at >= ?
                """,
                (JobState.INDEXED.value, cutoff),
            ).fetchall()
        for row in rows:
            indexed_at = _parse(row["indexed_at"])
            if indexed_at is None:
                continue
            day = indexed_at.astimezone(local_tz).date().isoformat()
            if day in counts:
                counts[day] += 1
        return [{"date": day, "count": count} for day, count in counts.items()]

    def list_node_ids(self) -> set[str]:
        with self._lock:
            rows = self._conn.execute("SELECT node_id FROM jobs").fetchall()
        return {r["node_id"] for r in rows}

    def changes_since(
        self, since: int, limit: int
    ) -> tuple[list[dict[str, str | int | None]], int]:
        """Rows whose ``transition_seq > since``, oldest first.

        Returns ``(transitions, max_seq_returned)``. ``max_seq_returned``
        is 0 when no rows match — caller should keep its cursor in that
        case. ``limit`` caps the response size; on a hot queue the
        caller can advance through chunks across successive polls.
        """
        capped = max(1, min(int(limit), 10_000))
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT node_id, state, indexed_at, last_error,
                       transition_seq
                FROM jobs
                WHERE transition_seq > ?
                ORDER BY transition_seq ASC
                LIMIT ?
                """,
                (int(since), capped),
            ).fetchall()
        if not rows:
            return [], 0
        transitions = [
            {
                "node_id": r["node_id"],
                "state": r["state"],
                "indexed_at": r["indexed_at"],
                "error": r["last_error"],
                "transition_seq": int(r["transition_seq"]),
            }
            for r in rows
        ]
        max_seq = int(rows[-1]["transition_seq"])
        return transitions, max_seq

    def head_seq(self) -> int:
        """Current ``MAX(transition_seq)`` — useful for callers that
        want to start tailing from "now" without first replaying all
        history."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(transition_seq), 0) FROM jobs"
            ).fetchone()
        return int(row[0]) if row is not None else 0

    def snapshot(self) -> dict[str, dict[str, str | None]]:
        """Per-node ``(state, modified_at)`` snapshot of the queue.

        Used by the resync flow: Rust calls ``GET /index/snapshot`` to
        learn what the sidecar already has indexed, then diffs against
        ``cognios.db`` to identify stale or missing nodes that need
        forwarding. Returning lightweight metadata (no error strings,
        no path) keeps the response payload small even for thousand-
        node workspaces.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT node_id, state, modified_at FROM jobs"
            ).fetchall()
        return {
            r["node_id"]: {
                "state": r["state"],
                "modified_at": r["modified_at"],
            }
            for r in rows
        }

    # ----- lifecycle ----------------------------------------------------

    def reset_stale_indexing(self) -> int:
        """Reset rows stuck in ``indexing`` to ``pending``.

        Called once at queue open. Mirrors the existing url-job pattern.
        Returns the number of rows reset.

        Bumps ``transition_seq`` per-row so each reset shows up as a
        distinct transition for the Rust poll cursor; a bulk UPDATE
        with a single seq would collapse N transitions into one and
        risk loss-on-pagination if more than ``limit`` rows share a
        seq value.
        """
        with self._lock, self._conn:
            stale_ids = [
                r["node_id"]
                for r in self._conn.execute(
                    "SELECT node_id FROM jobs WHERE state = ?",
                    (JobState.INDEXING.value,),
                ).fetchall()
            ]
            for node_id in stale_ids:
                seq = self._next_transition_seq()
                self._conn.execute(
                    """
                    UPDATE jobs SET state = ?, last_error = NULL,
                                   transition_seq = ?
                    WHERE node_id = ?
                    """,
                    (JobState.PENDING.value, seq, node_id),
                )
        return len(stale_ids)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass


# ----- module-level constructor + helpers --------------------------------


def open_queue(path: Path) -> IndexingQueue:
    """Open ``queue.db`` (creating it if absent) with WAL +
    integrity-check + stale-row reset.

    Schema migrations are declared in
    :mod:`search_sidecar.index.migrations` and applied before stale
    ``indexing`` rows are reset.

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
        run_migrations(conn)
    except sqlite3.DatabaseError:
        conn.close()
        raise
    queue = IndexingQueue(conn)
    reset = queue.reset_stale_indexing()
    if reset:
        LOG.info("queue: reset %d stale 'indexing' rows to 'pending'", reset)
    return queue


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
        content_version=row.get("content_version"),
    )


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def _content_version(
    kind: str, path_value: str | None, fallback_modified_at: str
) -> str:
    if path_value:
        try:
            stat = Path(path_value).stat()
            return f"stat:{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:
            pass
    if kind in {"folder", "mount", "directory"}:
        return f"container:{kind}"
    return f"event:{fallback_modified_at}"
