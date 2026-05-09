"""Versioned SQLite migrations for the persistent indexing queue."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class SQLiteMigration:
    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]


def run_migrations(conn: sqlite3.Connection) -> None:
    """Apply all queue schema migrations newer than ``PRAGMA user_version``."""
    current_version = _user_version(conn)
    for migration in QUEUE_MIGRATIONS:
        if current_version >= migration.version:
            continue
        migration.apply(conn)
        conn.execute(f"PRAGMA user_version = {migration.version}")
        current_version = migration.version


def _apply_initial_schema(conn: sqlite3.Connection) -> None:
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


def _apply_transition_seq(conn: sqlite3.Connection) -> None:
    if not _has_column(conn, "jobs", "transition_seq"):
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN transition_seq INTEGER NOT NULL DEFAULT 0"
        )
        # Backfill distinct seq values so existing rows appear once in
        # the next /index/changes poll. ROWID order gives deterministic
        # migration ordering for legacy rows.
        conn.execute(
            """
            UPDATE jobs
            SET transition_seq = (
                SELECT COUNT(*) FROM jobs AS j2
                WHERE j2.rowid <= jobs.rowid
            )
            """
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_transition_seq ON jobs(transition_seq)"
    )


def _apply_content_versions(conn: sqlite3.Connection) -> None:
    if not _has_column(conn, "jobs", "content_version"):
        conn.execute("ALTER TABLE jobs ADD COLUMN content_version TEXT")
    if not _has_column(conn, "jobs", "indexed_content_version"):
        conn.execute("ALTER TABLE jobs ADD COLUMN indexed_content_version TEXT")


def _apply_image_enhancement_columns(conn: sqlite3.Connection) -> None:
    # Defaults are correct for legacy rows: existing images start as
    # "not enhanced, not failed, zero attempts" until the watcher /
    # startup backfill flips enhancement_pending for eligible rows.
    if not _has_column(conn, "jobs", "enhancement_pending"):
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN enhancement_pending INTEGER NOT NULL DEFAULT 0"
        )
    if not _has_column(conn, "jobs", "enhancement_attempts"):
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN enhancement_attempts INTEGER NOT NULL DEFAULT 0"
        )
    if not _has_column(conn, "jobs", "enhancement_failed"):
        conn.execute(
            "ALTER TABLE jobs ADD COLUMN enhancement_failed INTEGER NOT NULL DEFAULT 0"
        )
    if not _has_column(conn, "jobs", "enhancement_completed_at"):
        conn.execute("ALTER TABLE jobs ADD COLUMN enhancement_completed_at TEXT")


QUEUE_MIGRATIONS: tuple[SQLiteMigration, ...] = (
    SQLiteMigration(1, "initial_jobs", _apply_initial_schema),
    SQLiteMigration(2, "transition_seq", _apply_transition_seq),
    SQLiteMigration(3, "content_versions", _apply_content_versions),
    SQLiteMigration(4, "image_enhancement_columns", _apply_image_enhancement_columns),
)

LATEST_QUEUE_SCHEMA_VERSION = QUEUE_MIGRATIONS[-1].version


def _user_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0] if row is not None else 0)


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return column in {
        row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }
