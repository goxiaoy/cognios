"""Search orchestrator.

Phase 2 / Unit 6 part 1 ships the **FTS-only** path. Hybrid (vector +
cross-encoder rerank) lands once the real ONNX embedder + reranker are
loaded — the response envelope already carries a ``degraded`` flag the
UI can surface as a banner ("Semantic search initialising — showing
keyword matches"). The orchestrator's structure leaves clean seams for
the vector + rerank steps to drop in.

Pipeline (current):

1. Parse the query → free text + filters (``kind:``, ``mount:``).
2. Run FTS over chunks with ``limit=200`` (over-fetch — see plan
   Architecture, the per-node aggregation step can collapse below
   the user-visible cap on dense topics).
3. Aggregate per-``node_id``: keep MAX score and the matched chunk's
   text as the snippet.
4. Trim to top 15 nodes.
5. Build typed :class:`SearchResult` rows and return inside a
   :class:`SearchResponse` envelope.

Pipeline (Phase 2 / Unit 6 part 2 — when embedder is ready):

   Replace step 2 with ``query_type="hybrid"`` + the embedder's
   ``embed([query])[0]`` vector. Add a step 4.5 that re-ranks the
   top-15 with the cross-encoder. Flip ``degraded`` to ``False``.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field

from ..index.embedder import Embedder, StubEmbedder
from ..storage import LanceDBStore
from .filters import ParsedQuery, parse_query

LOG = logging.getLogger("search_sidecar.retrieval.search")

DEFAULT_OVER_FETCH = 200
DEFAULT_TOP_NODES = 15
SNIPPET_MAX_CHARS = 150


@dataclass(frozen=True)
class SearchRequest:
    query: str
    limit: int | None = None  # caller cap on returned nodes; defaults to 15


@dataclass(frozen=True)
class SearchResult:
    node_id: str
    kind: str
    name: str
    score: float
    snippet: str
    matched_in: str  # "name" | "content" | "both"
    path: str | None = None  # breadcrumb; populated Rust-side post-filter


@dataclass(frozen=True)
class SearchResponse:
    results: tuple[SearchResult, ...]
    degraded: bool
    partial: dict | None = None
    state: str | None = None  # "ready" | "initialising" | "unavailable"

    def to_dict(self) -> dict:
        return {
            "results": [asdict(r) for r in self.results],
            "degraded": self.degraded,
            "partial": self.partial,
            "state": self.state,
        }


class SearchOrchestrator:
    """Stateless orchestrator. Construct once with the lancedb store
    and the embedder; call :meth:`search` per request.

    The embedder is held but not yet used — its readiness controls
    whether we serve the FTS-only or hybrid path. With
    :class:`StubEmbedder` we always degrade to FTS.
    """

    def __init__(
        self,
        *,
        store: LanceDBStore,
        embedder: Embedder,
        over_fetch: int = DEFAULT_OVER_FETCH,
        top_nodes: int = DEFAULT_TOP_NODES,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._over_fetch = over_fetch
        self._top_nodes = top_nodes

    def search(self, request: SearchRequest) -> SearchResponse:
        parsed = parse_query(request.query or "")
        limit = request.limit or self._top_nodes

        # FTS-only path. Hybrid path lands when a non-stub embedder is
        # wired (Unit 6 part 2).
        rows = self._store.fts_search(
            parsed.text,
            filter_sql=parsed.filter_sql(),
            limit=self._over_fetch,
        )

        results = self._aggregate_per_node(rows, parsed, limit)
        degraded = self._is_degraded()

        return SearchResponse(
            results=tuple(results),
            degraded=degraded,
            partial=None,
            state="ready",
        )

    # ----- internals ---------------------------------------------------

    def _is_degraded(self) -> bool:
        """``True`` while the embedder is a stub. Once the real ONNX
        embedder is loaded and reports ``ready``, this returns
        ``False`` and the search() path will route to hybrid + rerank.
        """
        return isinstance(self._embedder, StubEmbedder)

    def _aggregate_per_node(
        self,
        rows: list[dict],
        parsed: ParsedQuery,
        limit: int,
    ) -> list[SearchResult]:
        """Group chunk rows by ``node_id``, keep MAX score, build the
        snippet from the highest-scoring chunk's text."""
        if not rows:
            return []
        best: dict[str, dict] = {}
        for row in rows:
            node_id = row.get("node_id")
            if not node_id:
                continue
            score = _row_score(row)
            existing = best.get(node_id)
            if existing is None or score > existing["_agg_score"]:
                best[node_id] = {**row, "_agg_score": score}

        ranked = sorted(
            best.values(),
            key=lambda r: r["_agg_score"],
            reverse=True,
        )[:limit]

        out: list[SearchResult] = []
        for r in ranked:
            text = r.get("text") or ""
            snippet = _make_snippet(text, parsed.text)
            matched_in = _matched_in(parsed.text, r.get("name") or "", text)
            out.append(
                SearchResult(
                    node_id=r["node_id"],
                    kind=r.get("kind") or "",
                    name=r.get("name") or "",
                    score=float(r["_agg_score"]),
                    snippet=snippet,
                    matched_in=matched_in,
                )
            )
        return out


def _row_score(row: dict) -> float:
    """Pull the numeric score lancedb attached.

    lancedb's FTS path adds ``_score``; the brute-force search path
    uses ``_distance`` (lower = better). FTS is the only path Phase 2.1
    uses, but we guard for both to keep the function robust as the
    pipeline grows.
    """
    if "_score" in row and row["_score"] is not None:
        return float(row["_score"])
    if "_distance" in row and row["_distance"] is not None:
        # Distance is inverse to score; convert to a same-shape value.
        return -float(row["_distance"])
    return 0.0


def _make_snippet(text: str, query: str) -> str:
    """Return a ``SNIPPET_MAX_CHARS``-bounded slice of ``text`` centred
    on the first query-term match if any term matches; otherwise
    return the leading window.

    The frontend renders snippets via React text nodes only — never
    via dangerouslySetInnerHTML — so the snippet is plain text.
    Highlighting offsets are a Phase 4 / Unit 8 concern; for now we
    return raw text and let the UI compute match offsets client-side.
    """
    if not text:
        return ""
    if len(text) <= SNIPPET_MAX_CHARS:
        return text.strip()

    terms = [t for t in (query or "").split() if t.strip()]
    lower = text.lower()
    for term in terms:
        idx = lower.find(term.lower())
        if idx == -1:
            continue
        start = max(0, idx - SNIPPET_MAX_CHARS // 3)
        end = min(len(text), start + SNIPPET_MAX_CHARS)
        snippet = text[start:end].strip()
        if start > 0:
            snippet = "…" + snippet
        if end < len(text):
            snippet = snippet + "…"
        return snippet

    # No match — fall back to the leading window.
    return text[:SNIPPET_MAX_CHARS].strip() + "…"


def _matched_in(query: str, name: str, text: str) -> str:
    """Plan R2: ``matched_in`` is one of ``name``, ``content``, or
    ``both``. We approximate it by a lowercase substring check on
    each."""
    if not query:
        return "content"
    q_lower = query.lower()
    in_name = q_lower in (name or "").lower()
    in_text = q_lower in (text or "").lower()
    if in_name and in_text:
        return "both"
    if in_name:
        return "name"
    return "content"
