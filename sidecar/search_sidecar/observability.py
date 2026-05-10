"""Privacy-safe local observability aggregates.

The Home dashboard needs recent operational signals without turning
prompts, source text, file paths, or provider payloads into analytics
data. This module keeps only bounded durations, counts, provider/model
ids, and numeric token usage. Production sidecars persist those samples
to a local SQLite database; tests can still use the in-memory mode.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any


MAX_DURATION_SAMPLES = 256
OBSERVABILITY_RETENTION_DAYS = 90
LATEST_OBSERVABILITY_SCHEMA_VERSION = 1
LATENCY_KINDS = ("search", "indexing", "enhancement", "model_download")
TOKEN_USAGE_KIND = "token_usage"
LOG = logging.getLogger("search_sidecar.observability")


@dataclass(frozen=True)
class DurationSample:
    elapsed_ms: int
    ok: bool = True


@dataclass
class UsageTotals:
    provider_id: str
    model: str
    requests: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def to_dict(self) -> dict:
        return {
            "provider_id": self.provider_id,
            "model": self.model,
            "requests": self.requests,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }


class ObservabilityStore:
    def __init__(
        self,
        *,
        max_duration_samples: int = MAX_DURATION_SAMPLES,
        conn: sqlite3.Connection | None = None,
        retention_days: int = OBSERVABILITY_RETENTION_DAYS,
    ) -> None:
        self._lock = threading.RLock()
        self._durations: dict[str, deque[DurationSample]] = defaultdict(
            lambda: deque(maxlen=max_duration_samples)
        )
        self._usage: dict[tuple[str, str], UsageTotals] = {}
        self._conn = conn
        self._retention_days = retention_days
        self._last_retention_at = 0.0
        if self._conn is not None:
            self._conn.row_factory = sqlite3.Row

    def record_duration(
        self,
        kind: str,
        elapsed_ms: int,
        *,
        ok: bool = True,
        occurred_at: datetime | None = None,
    ) -> None:
        if elapsed_ms < 0:
            return
        occurred = _coerce_utc(occurred_at)
        with self._lock:
            self._durations[kind].append(
                DurationSample(elapsed_ms=int(elapsed_ms), ok=ok)
            )
            if self._conn is not None:
                self._insert_sample(
                    occurred_at=occurred,
                    kind=kind,
                    ok=ok,
                    duration_ms=int(elapsed_ms),
                )
                self._prune_if_due()

    def record_usage(
        self,
        *,
        provider_id: str | None,
        model: str | None,
        usage: dict[str, Any] | None,
        occurred_at: datetime | None = None,
    ) -> None:
        if not provider_id or not model or not usage:
            return
        prompt = _int_value(
            usage,
            "prompt_tokens",
            "prompt_eval_count",
            "input_tokens",
            "inputTokenCount",
        )
        completion = _int_value(
            usage,
            "completion_tokens",
            "completion_eval_count",
            "eval_count",
            "output_tokens",
            "outputTokenCount",
        )
        total = _int_value(usage, "total_tokens", "totalTokenCount")
        if total == 0 and (prompt or completion):
            total = prompt + completion
        if prompt == 0 and completion == 0 and total == 0:
            return

        key = (provider_id, model)
        occurred = _coerce_utc(occurred_at)
        with self._lock:
            current = self._usage.get(key)
            if current is None:
                current = UsageTotals(provider_id=provider_id, model=model)
                self._usage[key] = current
            current.requests += 1
            current.prompt_tokens += prompt
            current.completion_tokens += completion
            current.total_tokens += total
            if self._conn is not None:
                self._insert_sample(
                    occurred_at=occurred,
                    kind=TOKEN_USAGE_KIND,
                    ok=True,
                    provider_id=provider_id,
                    model=model,
                    prompt_tokens=prompt,
                    completion_tokens=completion,
                    total_tokens=total,
                )
                self._prune_if_due()

    def summary(
        self,
        *,
        recent_indexed_nodes: list[dict] | None = None,
        recent_days: int = 30,
    ) -> dict:
        with self._lock:
            if self._conn is not None:
                latency = {
                    kind: self._duration_summary_from_db(kind, recent_days=recent_days)
                    for kind in LATENCY_KINDS
                }
                token_usage = self._token_usage_from_db(recent_days=recent_days)
                latency_trends = {
                    kind: self._latency_trend_from_db(kind, recent_days=recent_days)
                    for kind in LATENCY_KINDS
                }
            else:
                latency = {
                    kind: self._duration_summary(kind) for kind in LATENCY_KINDS
                }
                token_usage = [
                    totals.to_dict()
                    for totals in sorted(
                        self._usage.values(),
                        key=lambda item: item.total_tokens,
                        reverse=True,
                    )
                ]
                latency_trends = {kind: [] for kind in LATENCY_KINDS}
        return {
            "recent_indexed_nodes": recent_indexed_nodes or [],
            "latency": latency,
            "token_usage": token_usage,
            "latency_trends": latency_trends,
        }

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def _duration_summary(self, kind: str) -> dict:
        samples = list(self._durations.get(kind, ()))
        values = sorted(sample.elapsed_ms for sample in samples)
        failures = sum(1 for sample in samples if not sample.ok)
        return {
            "sample_count": len(values),
            "failure_count": failures,
            "latest_ms": samples[-1].elapsed_ms if samples else None,
            "p50_ms": _percentile(values, 50),
            "p90_ms": _percentile(values, 90),
            "p99_ms": _percentile(values, 99),
        }

    def _duration_summary_from_db(self, kind: str, *, recent_days: int) -> dict:
        assert self._conn is not None
        rows = self._conn.execute(
            """
            SELECT duration_ms, ok
            FROM observability_samples
            WHERE kind = ?
              AND duration_ms IS NOT NULL
              AND occurred_at >= ?
            ORDER BY occurred_at ASC, id ASC
            """,
            (kind, _window_start_iso(recent_days)),
        ).fetchall()
        return _duration_summary_from_pairs(
            [(int(row["duration_ms"]), bool(row["ok"])) for row in rows]
        )

    def _latency_trend_from_db(self, kind: str, *, recent_days: int) -> list[dict]:
        assert self._conn is not None
        days = _recent_day_strings(recent_days)
        buckets: dict[str, list[tuple[int, bool]]] = {day: [] for day in days}
        rows = self._conn.execute(
            """
            SELECT occurred_at, duration_ms, ok
            FROM observability_samples
            WHERE kind = ?
              AND duration_ms IS NOT NULL
              AND occurred_at >= ?
            ORDER BY occurred_at ASC, id ASC
            """,
            (kind, _window_start_iso(recent_days)),
        ).fetchall()
        for row in rows:
            bucket = str(row["occurred_at"])[:10]
            if bucket in buckets:
                buckets[bucket].append((int(row["duration_ms"]), bool(row["ok"])))
        return [
            _trend_point(day, buckets[day])
            for day in days
        ]

    def _token_usage_from_db(self, *, recent_days: int) -> list[dict]:
        assert self._conn is not None
        rows = self._conn.execute(
            """
            SELECT
              provider_id,
              model,
              COUNT(*) AS requests,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(total_tokens) AS total_tokens
            FROM observability_samples
            WHERE kind = ?
              AND occurred_at >= ?
              AND provider_id IS NOT NULL
              AND model IS NOT NULL
            GROUP BY provider_id, model
            HAVING total_tokens > 0
            ORDER BY total_tokens DESC
            """,
            (TOKEN_USAGE_KIND, _window_start_iso(recent_days)),
        ).fetchall()
        return [
            {
                "provider_id": row["provider_id"],
                "model": row["model"],
                "requests": int(row["requests"] or 0),
                "prompt_tokens": int(row["prompt_tokens"] or 0),
                "completion_tokens": int(row["completion_tokens"] or 0),
                "total_tokens": int(row["total_tokens"] or 0),
            }
            for row in rows
        ]

    def _insert_sample(
        self,
        *,
        occurred_at: datetime,
        kind: str,
        ok: bool,
        duration_ms: int | None = None,
        provider_id: str | None = None,
        model: str | None = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
    ) -> None:
        assert self._conn is not None
        self._conn.execute(
            """
            INSERT INTO observability_samples (
              occurred_at,
              kind,
              ok,
              duration_ms,
              provider_id,
              model,
              prompt_tokens,
              completion_tokens,
              total_tokens
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                occurred_at.isoformat(),
                kind,
                1 if ok else 0,
                duration_ms,
                provider_id,
                model,
                prompt_tokens,
                completion_tokens,
                total_tokens,
            ),
        )

    def _prune_if_due(self) -> None:
        if self._conn is None:
            return
        now = time.monotonic()
        if now - self._last_retention_at < 60:
            return
        _prune_old_samples(self._conn, retention_days=self._retention_days)
        self._last_retention_at = now


def open_observability_store(path: Path) -> ObservabilityStore:
    """Open ``observability.db`` with WAL, migrations, and recovery."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return _open_or_create(path)
    except sqlite3.DatabaseError as err:
        backup = path.with_suffix(path.suffix + f".corrupt-{int(time.time())}")
        path.rename(backup)
        LOG.warning(
            "observability.db unreadable (%s); renamed to %s and recreating",
            err,
            backup,
        )
        return _open_or_create(path)


def _open_or_create(path: Path) -> ObservabilityStore:
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        integrity = conn.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise sqlite3.DatabaseError(f"quick_check returned {integrity!r}")
        _run_migrations(conn)
        _prune_old_samples(conn, retention_days=OBSERVABILITY_RETENTION_DAYS)
    except sqlite3.DatabaseError:
        conn.close()
        raise
    return ObservabilityStore(conn=conn)


def _run_migrations(conn: sqlite3.Connection) -> None:
    current_version = _user_version(conn)
    if current_version < 1:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS observability_samples (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              occurred_at TEXT NOT NULL,
              kind TEXT NOT NULL,
              ok INTEGER NOT NULL DEFAULT 1,
              duration_ms INTEGER,
              provider_id TEXT,
              model TEXT,
              prompt_tokens INTEGER NOT NULL DEFAULT 0,
              completion_tokens INTEGER NOT NULL DEFAULT 0,
              total_tokens INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_observability_samples_kind_time
              ON observability_samples(kind, occurred_at);
            CREATE INDEX IF NOT EXISTS idx_observability_samples_provider_model_time
              ON observability_samples(provider_id, model, occurred_at);
            CREATE INDEX IF NOT EXISTS idx_observability_samples_time
              ON observability_samples(occurred_at);
            """
        )
        conn.execute(f"PRAGMA user_version = {LATEST_OBSERVABILITY_SCHEMA_VERSION}")


def _user_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0] if row is not None else 0)


def _prune_old_samples(conn: sqlite3.Connection, *, retention_days: int) -> None:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=max(1, retention_days))
    ).isoformat()
    conn.execute(
        "DELETE FROM observability_samples WHERE occurred_at < ?",
        (cutoff,),
    )


def _percentile(values: list[int], percentile: int) -> int | None:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    rank = (percentile / 100) * (len(values) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(values) - 1)
    if lower == upper:
        return values[lower]
    fraction = rank - lower
    return round(values[lower] + (values[upper] - values[lower]) * fraction)


def _int_value(usage: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return max(value, 0)
        if isinstance(value, float):
            return max(int(value), 0)
    return 0


def _duration_summary_from_pairs(samples: list[tuple[int, bool]]) -> dict:
    values = sorted(elapsed for elapsed, _ok in samples)
    failures = sum(1 for _elapsed, ok in samples if not ok)
    return {
        "sample_count": len(values),
        "failure_count": failures,
        "latest_ms": samples[-1][0] if samples else None,
        "p50_ms": _percentile(values, 50),
        "p90_ms": _percentile(values, 90),
        "p99_ms": _percentile(values, 99),
    }


def _trend_point(bucket: str, samples: list[tuple[int, bool]]) -> dict:
    summary = _duration_summary_from_pairs(samples)
    return {
        "bucket": bucket,
        "sample_count": summary["sample_count"],
        "failure_count": summary["failure_count"],
        "p90_ms": summary["p90_ms"],
        "p99_ms": summary["p99_ms"],
    }


def _coerce_utc(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _recent_day_strings(days: int) -> list[str]:
    start = _window_start(days)
    return [
        (start + timedelta(days=offset)).date().isoformat()
        for offset in range(max(1, int(days)))
    ]


def _window_start_iso(days: int) -> str:
    return _window_start(days).isoformat()


def _window_start(days: int) -> datetime:
    capped_days = max(1, int(days))
    today = datetime.now(timezone.utc).date()
    return datetime.combine(
        today - timedelta(days=capped_days - 1),
        datetime.min.time(),
        tzinfo=timezone.utc,
    )
