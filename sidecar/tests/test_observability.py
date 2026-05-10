from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.index.queue import open_queue
from search_sidecar.observability import ObservabilityStore, open_observability_store

TOKEN = "0" * 64


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_observability_summary_starts_empty():
    app = build_app(token=TOKEN)
    with TestClient(app) as client:
        resp = client.get("/observability/summary", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["recent_indexed_nodes"] == []
    assert body["latency"]["search"]["sample_count"] == 0
    assert body["latency"]["search"]["p90_ms"] is None
    assert body["latency_trends"]["search"] == []
    assert body["token_usage"] == []


def test_observability_summary_reports_percentiles_and_usage():
    store = ObservabilityStore()
    for elapsed in (10, 20, 30, 40, 50):
        store.record_duration("search", elapsed)
    store.record_duration("search", 100, ok=False)
    store.record_usage(
        provider_id="local-ollama",
        model="llama3",
        usage={"prompt_eval_count": 12, "eval_count": 8},
    )
    app = build_app(token=TOKEN, observability_store=store)

    with TestClient(app) as client:
        resp = client.get("/observability/summary", headers=_auth())

    assert resp.status_code == 200
    body = resp.json()
    assert body["latency"]["search"]["sample_count"] == 6
    assert body["latency"]["search"]["failure_count"] == 1
    assert body["latency"]["search"]["p50_ms"] == 35
    assert body["latency"]["search"]["p90_ms"] == 75
    assert body["latency_trends"]["search"] == []
    assert body["token_usage"] == [
        {
            "provider_id": "local-ollama",
            "model": "llama3",
            "requests": 1,
            "prompt_tokens": 12,
            "completion_tokens": 8,
            "total_tokens": 20,
        }
    ]


def test_observability_summary_supports_recent_day_windows(tmp_path: Path):
    queue = open_queue(tmp_path / "queue.db")
    try:
        queue.enqueue(node_id="aaa", kind="note", name="A")
        queue.claim_next()
        queue.mark_indexed("aaa")
        app = build_app(token=TOKEN, indexing_queue=queue)

        with TestClient(app) as client:
            seven = client.get(
                "/observability/summary?recent_days=7", headers=_auth()
            )
            thirty = client.get(
                "/observability/summary?recent_days=30", headers=_auth()
            )
            ninety = client.get(
                "/observability/summary?recent_days=90", headers=_auth()
            )
            invalid = client.get(
                "/observability/summary?recent_days=14", headers=_auth()
            )

        assert seven.status_code == 200
        assert len(seven.json()["recent_indexed_nodes"]) == 7
        assert seven.json()["recent_indexed_nodes"][-1]["count"] >= 1
        assert thirty.status_code == 200
        assert len(thirty.json()["recent_indexed_nodes"]) == 30
        assert ninety.status_code == 200
        assert len(ninety.json()["recent_indexed_nodes"]) == 90
        assert invalid.status_code == 422
    finally:
        queue.close()


def test_observability_store_persists_latency_samples(tmp_path: Path):
    db_path = tmp_path / "observability.db"
    store = open_observability_store(db_path)
    try:
        store.record_duration("search", 10)
        store.record_duration("search", 30)
    finally:
        store.close()

    reopened = open_observability_store(db_path)
    try:
        summary = reopened.summary(recent_days=7)
    finally:
        reopened.close()

    assert summary["latency"]["search"]["sample_count"] == 2
    assert summary["latency"]["search"]["p90_ms"] == 28
    assert len(summary["latency_trends"]["search"]) == 7
    assert summary["latency_trends"]["search"][-1]["sample_count"] == 2
    assert summary["latency_trends"]["search"][-1]["p50_ms"] == 20
    assert summary["latency_trends"]["search"][-1]["p99_ms"] == 30

    conn = sqlite3.connect(db_path)
    try:
        rollup = conn.execute(
            """
            SELECT count, sum, min, max
            FROM observability_metric_rollups
            WHERE metric = 'latency.search.duration_ms'
            """
        ).fetchone()
    finally:
        conn.close()
    assert rollup == (2, 40, 10, 30)


def test_observability_store_persists_windowed_token_usage(tmp_path: Path):
    db_path = tmp_path / "observability.db"
    now = datetime.now(timezone.utc)
    store = open_observability_store(db_path)
    try:
        store.record_usage(
            provider_id="local-ollama",
            model="llama3",
            usage={"prompt_eval_count": 10, "eval_count": 5},
            occurred_at=now - timedelta(days=10),
        )
        store.record_usage(
            provider_id="local-ollama",
            model="llama3",
            usage={"prompt_eval_count": 7, "eval_count": 3},
            occurred_at=now,
        )
    finally:
        store.close()

    reopened = open_observability_store(db_path)
    try:
        seven = reopened.summary(recent_days=7)
        thirty = reopened.summary(recent_days=30)
    finally:
        reopened.close()

    assert seven["token_usage"] == [
        {
            "provider_id": "local-ollama",
            "model": "llama3",
            "requests": 1,
            "prompt_tokens": 7,
            "completion_tokens": 3,
            "total_tokens": 10,
        }
    ]
    assert thirty["token_usage"] == [
        {
            "provider_id": "local-ollama",
            "model": "llama3",
            "requests": 2,
            "prompt_tokens": 17,
            "completion_tokens": 8,
            "total_tokens": 25,
        }
    ]

    conn = sqlite3.connect(db_path)
    try:
        rollup = conn.execute(
            """
            SELECT SUM(count), SUM(sum)
            FROM observability_metric_rollups
            WHERE metric = 'llm.tokens.total'
              AND provider_id = 'local-ollama'
              AND model = 'llama3'
            """
        ).fetchone()
    finally:
        conn.close()
    assert rollup == (2, 25)


def test_observability_store_migrates_v1_samples_into_rollups(tmp_path: Path):
    db_path = tmp_path / "observability.db"
    occurred_at = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE observability_samples (
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
            PRAGMA user_version = 1;
            """
        )
        conn.execute(
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
            VALUES (?, 'token_usage', 1, NULL, 'openai', 'gpt-test', 4, 6, 10)
            """,
            (occurred_at,),
        )
        conn.execute(
            """
            INSERT INTO observability_samples (
              occurred_at,
              kind,
              ok,
              duration_ms
            )
            VALUES (?, 'search', 1, 25)
            """,
            (occurred_at,),
        )
        conn.commit()
    finally:
        conn.close()

    store = open_observability_store(db_path)
    try:
        summary = store.summary(recent_days=7)
    finally:
        store.close()

    assert summary["token_usage"][0]["total_tokens"] == 10
    conn = sqlite3.connect(db_path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        duration_rollup = conn.execute(
            """
            SELECT count, sum, min, max
            FROM observability_metric_rollups
            WHERE metric = 'latency.search.duration_ms'
            """
        ).fetchone()
    finally:
        conn.close()
    assert version == 2
    assert duration_rollup == (1, 25, 25, 25)


def test_observability_route_applies_recent_window_to_metrics(tmp_path: Path):
    store = open_observability_store(tmp_path / "observability.db")
    now = datetime.now(timezone.utc)
    try:
        store.record_duration("search", 10, occurred_at=now - timedelta(days=10))
        store.record_duration("search", 40, occurred_at=now)
        store.record_usage(
            provider_id="openai",
            model="gpt-test",
            usage={"prompt_tokens": 10, "completion_tokens": 5},
            occurred_at=now - timedelta(days=10),
        )
        store.record_usage(
            provider_id="openai",
            model="gpt-test",
            usage={"prompt_tokens": 2, "completion_tokens": 3},
            occurred_at=now,
        )
        app = build_app(token=TOKEN, observability_store=store)

        with TestClient(app) as client:
            seven = client.get(
                "/observability/summary?recent_days=7", headers=_auth()
            ).json()
            thirty = client.get(
                "/observability/summary?recent_days=30", headers=_auth()
            ).json()
    finally:
        store.close()

    assert seven["latency"]["search"]["sample_count"] == 1
    assert seven["latency"]["search"]["latest_ms"] == 40
    assert seven["token_usage"][0]["total_tokens"] == 5
    assert thirty["latency"]["search"]["sample_count"] == 2
    assert thirty["token_usage"][0]["total_tokens"] == 20
