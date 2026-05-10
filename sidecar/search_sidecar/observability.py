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
LATEST_OBSERVABILITY_SCHEMA_VERSION = 2
LATENCY_KINDS = ("search", "indexing", "enhancement", "model_download")
TOKEN_USAGE_KIND = "token_usage"
METRIC_LLM_REQUESTS = "llm.requests"
METRIC_LLM_TOKENS_PROMPT = "llm.tokens.prompt"
METRIC_LLM_TOKENS_COMPLETION = "llm.tokens.completion"
METRIC_LLM_TOKENS_TOTAL = "llm.tokens.total"
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
                self._record_metric_rollup(
                    occurred_at=occurred,
                    metric=f"latency.{kind}.duration_ms",
                    value=int(elapsed_ms),
                    kind=kind,
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
                self._record_token_rollups(
                    occurred_at=occurred,
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
                token_usage_by_day = self._token_usage_by_day_from_db(
                    recent_days=recent_days
                )
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
                token_usage_by_day = []
                latency_trends = {kind: [] for kind in LATENCY_KINDS}
        return {
            "recent_indexed_nodes": recent_indexed_nodes or [],
            "latency": latency,
            "token_usage": token_usage,
            "token_usage_by_day": token_usage_by_day,
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
              SUM(CASE WHEN metric = ? THEN sum ELSE 0 END) AS requests,
              SUM(CASE WHEN metric = ? THEN sum ELSE 0 END) AS prompt_tokens,
              SUM(CASE WHEN metric = ? THEN sum ELSE 0 END) AS completion_tokens,
              SUM(CASE WHEN metric = ? THEN sum ELSE 0 END) AS total_tokens
            FROM observability_metric_rollups
            WHERE bucket_size = 'day'
              AND bucket_start >= ?
              AND provider_id != ''
              AND model != ''
            GROUP BY provider_id, model
            HAVING total_tokens > 0
            ORDER BY total_tokens DESC
            """,
            (
                METRIC_LLM_REQUESTS,
                METRIC_LLM_TOKENS_PROMPT,
                METRIC_LLM_TOKENS_COMPLETION,
                METRIC_LLM_TOKENS_TOTAL,
                _window_start_iso(recent_days),
            ),
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

    def _token_usage_by_day_from_db(self, *, recent_days: int) -> list[dict]:
        assert self._conn is not None
        days = _recent_day_strings(recent_days)
        buckets: dict[str, list[dict]] = {day: [] for day in days}
        rows = self._conn.execute(
            """
            SELECT
              substr(bucket_start, 1, 10) AS day,
              provider_id,
              model,
              SUM(sum) AS total_tokens
            FROM observability_metric_rollups
            WHERE metric = ?
              AND bucket_size = 'day'
              AND bucket_start >= ?
              AND provider_id != ''
              AND model != ''
            GROUP BY day, provider_id, model
            HAVING total_tokens > 0
            ORDER BY day ASC, total_tokens DESC
            """,
            (METRIC_LLM_TOKENS_TOTAL, _window_start_iso(recent_days)),
        ).fetchall()
        for row in rows:
            day = str(row["day"])
            if day not in buckets:
                continue
            buckets[day].append(
                {
                    "provider_id": row["provider_id"],
                    "model": row["model"],
                    "total_tokens": int(row["total_tokens"] or 0),
                }
            )
        return [
            {
                "date": day,
                "total_tokens": sum(segment["total_tokens"] for segment in segments),
                "segments": segments,
            }
            for day, segments in buckets.items()
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

    def _record_token_rollups(
        self,
        *,
        occurred_at: datetime,
        provider_id: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
    ) -> None:
        self._record_metric_rollup(
            occurred_at=occurred_at,
            metric=METRIC_LLM_REQUESTS,
            value=1,
            kind=TOKEN_USAGE_KIND,
            provider_id=provider_id,
            model=model,
        )
        self._record_metric_rollup(
            occurred_at=occurred_at,
            metric=METRIC_LLM_TOKENS_PROMPT,
            value=prompt_tokens,
            kind=TOKEN_USAGE_KIND,
            provider_id=provider_id,
            model=model,
        )
        self._record_metric_rollup(
            occurred_at=occurred_at,
            metric=METRIC_LLM_TOKENS_COMPLETION,
            value=completion_tokens,
            kind=TOKEN_USAGE_KIND,
            provider_id=provider_id,
            model=model,
        )
        self._record_metric_rollup(
            occurred_at=occurred_at,
            metric=METRIC_LLM_TOKENS_TOTAL,
            value=total_tokens,
            kind=TOKEN_USAGE_KIND,
            provider_id=provider_id,
            model=model,
        )

    def _record_metric_rollup(
        self,
        *,
        occurred_at: datetime,
        metric: str,
        value: float,
        kind: str = "",
        provider_id: str | None = None,
        model: str | None = None,
    ) -> None:
        assert self._conn is not None
        _upsert_metric_rollup(
            self._conn,
            occurred_at=occurred_at,
            metric=metric,
            value=value,
            kind=kind,
            provider_id=provider_id,
            model=model,
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
    conn.row_factory = sqlite3.Row
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
        conn.execute("PRAGMA user_version = 1")
        current_version = 1
    if current_version < 2:
        _apply_metric_rollups_schema(conn)
        _backfill_metric_rollups(conn)
        conn.execute(f"PRAGMA user_version = {LATEST_OBSERVABILITY_SCHEMA_VERSION}")


def _apply_metric_rollups_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS observability_metric_rollups (
          bucket_start TEXT NOT NULL,
          bucket_size TEXT NOT NULL,
          metric TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT '',
          provider_id TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          count INTEGER NOT NULL DEFAULT 0,
          sum REAL NOT NULL DEFAULT 0,
          min REAL,
          max REAL,
          PRIMARY KEY (
            bucket_start,
            bucket_size,
            metric,
            kind,
            provider_id,
            model
          )
        );
        CREATE INDEX IF NOT EXISTS idx_observability_metric_rollups_metric_bucket
          ON observability_metric_rollups(metric, bucket_size, bucket_start);
        CREATE INDEX IF NOT EXISTS idx_observability_metric_rollups_provider_model
          ON observability_metric_rollups(provider_id, model, bucket_start);
        """
    )


def _backfill_metric_rollups(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT
          occurred_at,
          kind,
          duration_ms,
          provider_id,
          model,
          prompt_tokens,
          completion_tokens,
          total_tokens
        FROM observability_samples
        ORDER BY occurred_at ASC, id ASC
        """
    ).fetchall()
    for row in rows:
        occurred_at = _parse_iso_datetime(str(row["occurred_at"]))
        kind = str(row["kind"])
        duration_ms = row["duration_ms"]
        if duration_ms is not None:
            _upsert_metric_rollup(
                conn,
                occurred_at=occurred_at,
                metric=f"latency.{kind}.duration_ms",
                value=int(duration_ms),
                kind=kind,
            )
        if kind == TOKEN_USAGE_KIND and row["provider_id"] and row["model"]:
            provider_id = str(row["provider_id"])
            model = str(row["model"])
            prompt_tokens = int(row["prompt_tokens"] or 0)
            completion_tokens = int(row["completion_tokens"] or 0)
            total_tokens = int(row["total_tokens"] or 0)
            _upsert_metric_rollup(
                conn,
                occurred_at=occurred_at,
                metric=METRIC_LLM_REQUESTS,
                value=1,
                kind=TOKEN_USAGE_KIND,
                provider_id=provider_id,
                model=model,
            )
            _upsert_metric_rollup(
                conn,
                occurred_at=occurred_at,
                metric=METRIC_LLM_TOKENS_PROMPT,
                value=prompt_tokens,
                kind=TOKEN_USAGE_KIND,
                provider_id=provider_id,
                model=model,
            )
            _upsert_metric_rollup(
                conn,
                occurred_at=occurred_at,
                metric=METRIC_LLM_TOKENS_COMPLETION,
                value=completion_tokens,
                kind=TOKEN_USAGE_KIND,
                provider_id=provider_id,
                model=model,
            )
            _upsert_metric_rollup(
                conn,
                occurred_at=occurred_at,
                metric=METRIC_LLM_TOKENS_TOTAL,
                value=total_tokens,
                kind=TOKEN_USAGE_KIND,
                provider_id=provider_id,
                model=model,
            )


def _upsert_metric_rollup(
    conn: sqlite3.Connection,
    *,
    occurred_at: datetime,
    metric: str,
    value: float,
    kind: str = "",
    provider_id: str | None = None,
    model: str | None = None,
) -> None:
    bucket_start = _bucket_start_iso(occurred_at)
    conn.execute(
        """
        INSERT INTO observability_metric_rollups (
          bucket_start,
          bucket_size,
          metric,
          kind,
          provider_id,
          model,
          count,
          sum,
          min,
          max
        )
        VALUES (?, 'day', ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(bucket_start, bucket_size, metric, kind, provider_id, model)
        DO UPDATE SET
          count = count + 1,
          sum = sum + excluded.sum,
          min = CASE
            WHEN min IS NULL THEN excluded.min
            WHEN excluded.min < min THEN excluded.min
            ELSE min
          END,
          max = CASE
            WHEN max IS NULL THEN excluded.max
            WHEN excluded.max > max THEN excluded.max
            ELSE max
          END
        """,
        (
            bucket_start,
            metric,
            kind,
            provider_id or "",
            model or "",
            value,
            value,
            value,
        ),
    )


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
        "p50_ms": summary["p50_ms"],
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


def _bucket_start_iso(value: datetime) -> str:
    occurred = _coerce_utc(value)
    return datetime.combine(
        occurred.date(),
        datetime.min.time(),
        tzinfo=timezone.utc,
    ).isoformat()


def _parse_iso_datetime(value: str) -> datetime:
    return _coerce_utc(datetime.fromisoformat(value))
