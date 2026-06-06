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
from search_sidecar.storage import EMBEDDING_DIMENSION, NodeChunk, open_store

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


def test_search_filters_stale_index_rows_by_active_node_ids(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    stale_id = "77777777-7777-7777-7777-777777777777"
    active_id = "88888888-8888-8888-8888-888888888888"
    text = "20260301肖裕意外\n/Users/goxy/Documents/20260301肖裕意外\nmount"
    store.upsert(
        [
            NodeChunk(
                id=f"{stale_id}:metadata:0",
                node_id=stale_id,
                kind="mount",
                name="20260301肖裕意外",
                text=text,
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="metadata",
            ),
            NodeChunk(
                id=f"{active_id}:metadata:0",
                node_id=active_id,
                kind="mount",
                name="20260301肖裕意外",
                text=text,
                vector=[0.0] * EMBEDDING_DIMENSION,
                role="metadata",
            ),
        ]
    )
    orch = SearchOrchestrator(
        store=store,
        embedder=StubEmbedder(),
        active_node_ids=lambda: {active_id},
    )

    resp = orch.search(SearchRequest(query="mount kind:mount"))

    assert [result.node_id for result in resp.results] == [active_id]


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


def test_search_returns_next_cursor_when_more_results_remain(setup):
    """With ``limit=2`` and 3 matching nodes, the response carries a
    ``next_cursor`` so the dedicated view can ask for the next page."""
    _, orch = setup
    # Query terms hit all three setup notes (oauth / pkce / rotate / ipsum).
    resp = orch.search(
        SearchRequest(query="oauth pkce rotate ipsum", limit=2)
    )
    assert len(resp.results) == 2
    assert resp.next_cursor == "offset:2"


def test_search_with_offset_cursor_returns_following_page(setup):
    _, orch = setup
    page1 = orch.search(
        SearchRequest(query="oauth pkce rotate ipsum", limit=2)
    )
    assert page1.next_cursor == "offset:2"
    page2 = orch.search(
        SearchRequest(
            query="oauth pkce rotate ipsum", limit=2, cursor=page1.next_cursor
        )
    )
    # Three rows total; page2 has the third row and no more.
    assert len(page2.results) == 1
    assert page2.next_cursor is None
    # The two pages do not repeat any node.
    page1_ids = {r.node_id for r in page1.results}
    page2_ids = {r.node_id for r in page2.results}
    assert page1_ids.isdisjoint(page2_ids)


def test_search_sort_modified_orders_by_modified_at_desc(setup, tmp_path: Path):
    """``sort=modified`` orders results by ``modified_at`` desc rather
    than relevance."""
    _, orch = setup
    resp = orch.search(
        SearchRequest(query="oauth pkce rotate ipsum", sort="modified")
    )
    assert resp.results
    # All notes were processed inside the same fixture; the most
    # recent (last-processed) appears first. The exact ordering
    # depends on row insertion timing, but every result should carry
    # a non-empty modified_at to allow the sort to work.
    for r in resp.results:
        assert r.modified_at is not None and r.modified_at != ""
    # And the values are in descending order.
    sorted_desc = sorted(
        [r.modified_at for r in resp.results], reverse=True
    )
    assert [r.modified_at for r in resp.results] == sorted_desc


def test_invalid_cursor_resets_to_first_page(setup):
    _, orch = setup
    resp = orch.search(
        SearchRequest(query="oauth", cursor="garbage:not-a-cursor")
    )
    # We get the first page rather than an error.
    assert resp.results


def test_orchestrator_uses_hybrid_search_when_embedder_is_semantic(
    tmp_path,
):
    """When the embedder advertises ``is_semantic=True`` the
    orchestrator must call ``hybrid_search`` and pass through the
    embedder's vector. The ``degraded`` flag flips to False."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
    from search_sidecar.storage import EMBEDDING_DIMENSION

    fake_embedder = mock.Mock()
    fake_embedder.is_semantic = True
    fake_embedder.embed.return_value = [[0.1] * EMBEDDING_DIMENSION]

    fake_store = mock.Mock()
    fake_store.hybrid_search.return_value = []
    fake_store.fts_search.return_value = []

    orch = SearchOrchestrator(store=fake_store, embedder=fake_embedder)
    resp = orch.search(SearchRequest(query="oauth"))

    fake_store.hybrid_search.assert_called_once()
    fake_store.fts_search.assert_not_called()
    fake_embedder.embed.assert_called_once_with(["oauth"])
    assert resp.degraded is False


def test_orchestrator_uses_hybrid_relevance_score_when_present(tmp_path):
    from unittest import mock

    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
    from search_sidecar.storage import EMBEDDING_DIMENSION

    fake_embedder = mock.Mock()
    fake_embedder.is_semantic = True
    fake_embedder.embed.return_value = [[0.1] * EMBEDDING_DIMENSION]

    fake_store = mock.Mock()
    fake_store.hybrid_search.return_value = [
        {
            "node_id": "n1",
            "kind": "note",
            "name": "Hybrid result",
            "text": "Hybrid result text",
            "_relevance_score": 0.42,
        }
    ]

    orch = SearchOrchestrator(store=fake_store, embedder=fake_embedder)
    resp = orch.search(SearchRequest(query="hybrid"))

    assert resp.results[0].score == 0.42
    assert resp.degraded is False


def test_orchestrator_falls_back_to_fts_when_embedder_raises(tmp_path):
    """A transient embedder failure must not kill the search request;
    the orchestrator logs and runs FTS-only with the same query."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest

    fake_embedder = mock.Mock()
    fake_embedder.is_semantic = True
    fake_embedder.embed.side_effect = RuntimeError("onnxruntime crashed")

    fake_store = mock.Mock()
    fake_store.fts_search.return_value = []

    orch = SearchOrchestrator(store=fake_store, embedder=fake_embedder)
    resp = orch.search(SearchRequest(query="oauth"))
    fake_store.hybrid_search.assert_not_called()
    fake_store.fts_search.assert_called_once()
    # ``degraded`` is still False because the embedder advertises
    # is_semantic=True; the fallback is a transient anomaly, not a
    # state change. The UI banner is driven by is_semantic, not by
    # this single-request fallback.
    assert resp.degraded is False
    assert resp.results == ()


def test_orchestrator_reorders_top_window_via_reranker(setup):
    """When a reranker is wired, the cross-encoder reorders the head
    of the candidate list. The reranker double here returns scores
    that put the *last* matching node first."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest

    _, baseline = setup
    # Pull baseline results so we know what order the FTS path produces.
    baseline_resp = baseline.search(SearchRequest(query="oauth pkce rotate"))
    assert len(baseline_resp.results) >= 2
    first_baseline = baseline_resp.results[0].node_id

    # Reranker-augmented orchestrator: same store + embedder, plus a
    # mock reranker that inverts the order (last → first). Scoring
    # ``[1, 2, 3, ...]`` then descending-sorting puts position N at
    # index 0.
    fake_reranker = mock.Mock()
    fake_reranker.rerank.side_effect = lambda query, docs: list(
        range(1, len(docs) + 1)
    )
    from search_sidecar.index.embedder import StubEmbedder
    reranked_orch = SearchOrchestrator(
        store=baseline._store,
        embedder=StubEmbedder(),
        reranker=fake_reranker,
    )
    reranked_resp = reranked_orch.search(
        SearchRequest(query="oauth pkce rotate")
    )
    fake_reranker.rerank.assert_called_once()
    # The reranker turned a descending score list into "last-first";
    # the new top result should be the previous *last* candidate.
    assert reranked_resp.results[0].node_id != first_baseline


def test_orchestrator_skips_reranker_when_sort_is_modified(setup):
    """``sort=modified`` is an explicit user choice; the reranker
    must not silently overrule it."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
    from search_sidecar.index.embedder import StubEmbedder

    _, base = setup
    fake_reranker = mock.Mock()
    orch = SearchOrchestrator(
        store=base._store,
        embedder=StubEmbedder(),
        reranker=fake_reranker,
    )
    orch.search(SearchRequest(query="oauth", sort="modified"))
    fake_reranker.rerank.assert_not_called()


def test_orchestrator_falls_back_to_initial_order_when_reranker_raises(setup):
    """A flaky reranker must not produce worse results than no
    reranker at all — log + return original ordering."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
    from search_sidecar.index.embedder import StubEmbedder

    _, base = setup
    baseline_resp = base.search(SearchRequest(query="oauth pkce rotate"))
    fake_reranker = mock.Mock()
    fake_reranker.rerank.side_effect = RuntimeError("onnx crashed")
    orch = SearchOrchestrator(
        store=base._store,
        embedder=StubEmbedder(),
        reranker=fake_reranker,
    )
    resp = orch.search(SearchRequest(query="oauth pkce rotate"))
    fake_reranker.rerank.assert_called_once()
    # Ordering is identical to the no-reranker baseline.
    assert [r.node_id for r in resp.results] == [
        r.node_id for r in baseline_resp.results
    ]


def test_orchestrator_skips_reranker_when_query_is_empty(setup):
    """Empty queries already short-circuit FTS to no results; the
    reranker must not be called on an empty doc list."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest
    from search_sidecar.index.embedder import StubEmbedder

    _, base = setup
    fake_reranker = mock.Mock()
    orch = SearchOrchestrator(
        store=base._store,
        embedder=StubEmbedder(),
        reranker=fake_reranker,
    )
    orch.search(SearchRequest(query=""))
    fake_reranker.rerank.assert_not_called()


def test_orchestrator_skips_hybrid_when_embedder_returns_empty(tmp_path):
    """An empty ``embed()`` result (degenerate input) should also
    fall through to FTS rather than passing an empty vector list to
    lancedb."""
    from unittest import mock
    from search_sidecar.retrieval import SearchOrchestrator, SearchRequest

    fake_embedder = mock.Mock()
    fake_embedder.is_semantic = True
    fake_embedder.embed.return_value = []

    fake_store = mock.Mock()
    fake_store.fts_search.return_value = []

    orch = SearchOrchestrator(store=fake_store, embedder=fake_embedder)
    orch.search(SearchRequest(query="oauth"))
    fake_store.hybrid_search.assert_not_called()
    fake_store.fts_search.assert_called_once()


def test_snippet_match_offsets_align_with_returned_string():
    """Every offset pair returned alongside the snippet must point at
    a substring equal (case-insensitive) to one of the query terms in
    the *snippet* string the frontend will render."""
    from search_sidecar.retrieval.search import _make_snippet

    text = "The quick brown fox jumps over the lazy OAuth dog quickly"
    snippet, offsets = _make_snippet(text, "OAuth quick")
    assert offsets, "expected at least one match offset"
    terms = {"oauth", "quick"}
    for start, end in offsets:
        slice_ = snippet[start:end].lower()
        # Term may be a prefix-of (e.g. quick → quickly), so we accept
        # any term that the slice starts with.
        assert any(
            slice_.startswith(term) or slice_ == term for term in terms
        ), f"slice {slice_!r} did not match any of {terms}"


def test_snippet_offsets_are_sorted_and_non_overlapping():
    from search_sidecar.retrieval.search import _make_snippet

    text = "OAuth oauth Oauth oauth"
    _, offsets = _make_snippet(text, "OAuth")
    assert offsets == sorted(offsets)
    for (a_start, a_end), (b_start, _) in zip(offsets, offsets[1:]):
        assert a_end <= b_start, "offsets overlap"


def test_snippet_offsets_account_for_ellipsis_prefix():
    """When the snippet is truncated with a leading "…", the offsets
    must point at the match within the *prefixed* string, not the
    raw text."""
    from search_sidecar.retrieval.search import _make_snippet

    text = "x" * 400 + " OAuth introduces PKCE for every public client " + "y" * 400
    snippet, offsets = _make_snippet(text, "OAuth")
    assert snippet.startswith("…")
    assert offsets, "expected at least one match offset"
    for start, end in offsets:
        assert snippet[start:end].lower() == "oauth"


def test_empty_query_returns_no_offsets():
    from search_sidecar.retrieval.search import _make_snippet

    snippet, offsets = _make_snippet("hello world", "")
    assert snippet == "hello world"
    assert offsets == []


def test_snippet_is_bounded(setup, tmp_path: Path):
    store, orch = setup
    long_note = tmp_path / "long.md"
    long_note.write_text("PKCE " * 200)  # 1000 chars
    proc = TextProcessor(store, StubEmbedder())
    proc.process(_make_job(long_note, node_id="77777777-7777-7777-7777-777777777777"))

    resp = orch.search(SearchRequest(query="PKCE"))
    for r in resp.results:
        assert len(r.snippet) <= 200, f"snippet too long: {len(r.snippet)}"
