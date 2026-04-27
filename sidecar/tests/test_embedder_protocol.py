"""Embedder protocol contract.

These pin the ``is_semantic`` field so a future refactor that removes
or renames it surfaces immediately. The orchestrator + factory both
key off this property; silently breaking it would route every search
to the FTS-only path.
"""

from __future__ import annotations

from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.storage import EMBEDDING_DIMENSION


def test_stub_embedder_advertises_non_semantic():
    embedder = StubEmbedder()
    assert embedder.is_semantic is False
    assert embedder.dimension == EMBEDDING_DIMENSION


def test_stub_embedder_returns_zero_vectors_at_correct_dimension():
    embedder = StubEmbedder()
    vectors = embedder.embed(["hello", "world"])
    assert len(vectors) == 2
    for v in vectors:
        assert len(v) == EMBEDDING_DIMENSION
        assert all(x == 0.0 for x in v)


def test_stub_embedder_returns_empty_list_for_no_inputs():
    embedder = StubEmbedder()
    assert embedder.embed([]) == []
