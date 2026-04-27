"""Search orchestrator: FTS over indexed chunks, per-node aggregation."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.processors.text import TextProcessor
from search_sidecar.index.queue import IndexingJob, JobState
from search_sidecar.retrieval import (
    SearchOrchestrator,
    SearchRequest,
)
from search_sidecar.storage import open_store

UUID_A = "11111111-1111-1111-1111-111111111111"
UUID_B = "22222222-2222-2222-2222-222222222222"
UUID_C = "33333333-3333-3333-3333-333333333333"


def _make_job(
    path: Path,
    *,
    node_id: str,
    kind: str = "note",
) -> IndexingJob:
    now = datetime.now(timezone.utc)
    return IndexingJob(
        node_id=node_id,
        kind=kind,
        name=path.name,
        absolute_content_path=str(path),
        mount_id=None,
        state=JobState.INDEXING,
        enqueued_at=now,
        indexed_at=None,
        last_error=None,
        attempts=1,
        created_at=now,
        modified_at=now,
    )


@pytest.fixture
def setup(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    embedder = StubEmbedder()
    proc = TextProcessor(store, embedder)
    orch = SearchOrchestrator(store=store, embedder=embedder)

    # Three notes with disjoint content so FTS scoring is unambiguous.
    a = tmp_path / "a.md"
    a.write_text("OAuth 2.1 introduces PKCE for every public client.")
    b = tmp_path / "b.md"
    b.write_text("Refresh tokens should rotate on each use, with replay detection.")
    c = tmp_path / "c.md"
    c.write_text("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")

    proc.process(_make_job(a, node_id=UUID_A))
    proc.process(_make_job(b, node_id=UUID_B))
    proc.process(_make_job(c, node_id=UUID_C))
    return store, orch


def test_search_returns_relevant_node_for_keyword(setup):
    _, orch = setup
    resp = orch.search(SearchRequest(query="PKCE"))
    assert resp.results
    top = resp.results[0]
    assert top.node_id == UUID_A
    assert "PKCE" in top.snippet


def test_search_response_envelope_shape(setup):
    _, orch = setup
    resp = orch.search(SearchRequest(query="rotate"))
    payload = resp.to_dict()
    assert set(payload.keys()) >= {"results", "degraded", "partial", "state"}
    # FTS-only mode while StubEmbedder is wired
    assert payload["degraded"] is True
    assert payload["state"] == "ready"


def test_search_with_kind_filter_excludes_other_kinds(setup, tmp_path: Path):
    store, orch = setup
    # Add a kind=file row that contains "PKCE"
    file_node = tmp_path / "extra.txt"
    file_node.write_text("PKCE wiki dump")
    proc = TextProcessor(store, StubEmbedder())
    proc.process(_make_job(file_node, node_id="44444444-4444-4444-4444-444444444444", kind="file"))

    resp = orch.search(SearchRequest(query="kind:note PKCE"))
    assert resp.results
    for r in resp.results:
        assert r.kind == "note"


def test_search_returns_empty_results_for_no_match(setup):
    _, orch = setup
    resp = orch.search(SearchRequest(query="nonexistentphrase987654321"))
    assert resp.results == ()
    assert resp.degraded is True


def test_search_aggregates_multiple_chunks_into_one_node(setup, tmp_path: Path):
    """A long note with the query term in two paragraphs returns one
    result row, not two."""
    store, orch = setup
    note = tmp_path / "long.md"
    note.write_text(
        "PKCE is the first paragraph mention.\n\n"
        "Another paragraph that also says PKCE plainly.\n\n"
        "Closing paragraph.\n"
    )
    proc = TextProcessor(store, StubEmbedder())
    proc.process(
        _make_job(note, node_id="55555555-5555-5555-5555-555555555555")
    )

    resp = orch.search(SearchRequest(query="PKCE"))
    node_ids = [r.node_id for r in resp.results]
    # That node id appears at most once in the result list
    assert node_ids.count("55555555-5555-5555-5555-555555555555") == 1


def test_search_respects_limit_argument(setup):
    _, orch = setup
    resp = orch.search(SearchRequest(query="oauth pkce rotate ipsum", limit=2))
    assert len(resp.results) <= 2


def test_matched_in_distinguishes_name_vs_content(setup, tmp_path: Path):
    store, orch = setup
    # Note whose NAME contains "OAuth" but body doesn't
    note = tmp_path / "OAuth-cheatsheet.md"
    note.write_text("Random body without that term.")
    proc = TextProcessor(store, StubEmbedder())
    proc.process(
        _make_job(note, node_id="66666666-6666-6666-6666-666666666666")
    )

    resp = orch.search(SearchRequest(query="OAuth"))
    # The OAuth-cheatsheet.md row should report matched_in="name" if it
    # surfaces; the original a.md row should still report content/both.
    found = {r.node_id: r.matched_in for r in resp.results}
    if "66666666-6666-6666-6666-666666666666" in found:
        assert found["66666666-6666-6666-6666-666666666666"] in {"name", "both"}
    if UUID_A in found:
        # a.md mentions OAuth in the body — content or both, never name
        assert found[UUID_A] in {"content", "both"}


def test_empty_query_returns_no_results(setup):
    _, orch = setup
    resp = orch.search(SearchRequest(query=""))
    assert resp.results == ()
    assert resp.degraded is True


def test_search_handles_empty_index(tmp_path: Path):
    """A search against a freshly-opened, empty store must not raise."""
    store = open_store(tmp_path / "index.lance")
    orch = SearchOrchestrator(store=store, embedder=StubEmbedder())
    resp = orch.search(SearchRequest(query="PKCE"))
    assert resp.results == ()
    assert resp.degraded is True


def test_snippet_is_bounded(setup, tmp_path: Path):
    store, orch = setup
    long_note = tmp_path / "long.md"
    long_note.write_text("PKCE " * 200)  # 1000 chars
    proc = TextProcessor(store, StubEmbedder())
    proc.process(_make_job(long_note, node_id="77777777-7777-7777-7777-777777777777"))

    resp = orch.search(SearchRequest(query="PKCE"))
    for r in resp.results:
        assert len(r.snippet) <= 200, f"snippet too long: {len(r.snippet)}"
