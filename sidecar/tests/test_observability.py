from __future__ import annotations

from fastapi.testclient import TestClient

from search_sidecar.app import build_app
from search_sidecar.observability import ObservabilityStore

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

