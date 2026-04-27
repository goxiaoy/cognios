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
from dataclasses import asdict, dataclass, field, replace
from typing import TYPE_CHECKING

from ..index.embedder import Embedder
from ..storage import LanceDBStore
from .filters import ParsedQuery, parse_query

if TYPE_CHECKING:
    from ..rerank import Reranker

LOG = logging.getLogger("search_sidecar.retrieval.search")

DEFAULT_OVER_FETCH = 200
DEFAULT_TOP_NODES = 15
SNIPPET_MAX_CHARS = 150
# Reranking is expensive (a cross-encoder forward pass per candidate
# pair) so we only rerank the head of the result list. Items beyond
# this window keep their pre-rerank order. 50 covers the dedicated
# view's first page; deep pagination falls through unchanged.
DEFAULT_RERANK_WINDOW = 50


SortMode = str  # "relevance" | "modified"
CURSOR_PREFIX = "offset:"
DEFAULT_DEDICATED_LIMIT = 50


@dataclass(frozen=True)
class SearchRequest:
    query: str
    limit: int | None = None  # caller cap on returned nodes; defaults to 15
    sort: SortMode = "relevance"  # "relevance" or "modified"
    cursor: str | None = None  # opaque token; v1 form is ``offset:N``


@dataclass(frozen=True)
class SearchResult:
    node_id: str
    kind: str
    name: str
    score: float
    snippet: str
    matched_in: str  # "name" | "content" | "both"
    path: str | None = None  # breadcrumb; populated Rust-side post-filter
    modified_at: str | None = None  # ISO 8601, used for sort=modified


@dataclass(frozen=True)
class SearchResponse:
    results: tuple[SearchResult, ...]
    degraded: bool
    partial: dict | None = None
    state: str | None = None  # "ready" | "initialising" | "unavailable"
    next_cursor: str | None = None  # only set when more results remain

    def to_dict(self) -> dict:
        return {
            "results": [asdict(r) for r in self.results],
            "degraded": self.degraded,
            "partial": self.partial,
            "state": self.state,
            "next_cursor": self.next_cursor,
        }


class SearchOrchestrator:
    """Stateless orchestrator. Construct once with the lancedb store
    and the embedder; call :meth:`search` per request.

    The embedder's :attr:`Embedder.is_semantic` property controls
    whether we serve the FTS-only or hybrid path. With
    ``StubEmbedder`` (``is_semantic=False``) we always degrade to FTS.
    """

    def __init__(
        self,
        *,
        store: LanceDBStore,
        embedder: Embedder,
        reranker: "Reranker | None" = None,
        over_fetch: int = DEFAULT_OVER_FETCH,
        top_nodes: int = DEFAULT_TOP_NODES,
        rerank_window: int = DEFAULT_RERANK_WINDOW,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._reranker = reranker
        self._over_fetch = over_fetch
        self._top_nodes = top_nodes
        self._rerank_window = rerank_window

    def search(self, request: SearchRequest) -> SearchResponse:
        parsed = parse_query(request.query or "")
        limit = request.limit or self._top_nodes
        offset = _decode_cursor(request.cursor)
        # Over-fetch from the underlying retrieval call proportionally
        # so paginating into deeper offsets still has chunks to
        # aggregate from. Capped to keep the round-trip bounded.
        over_fetch = max(self._over_fetch, (offset + limit + 1) * 4)
        filter_sql = parsed.filter_sql()

        # Route by embedder readiness:
        # - is_semantic=True → hybrid (vector + FTS) for richer recall
        # - is_semantic=False (StubEmbedder) → FTS-only fallback
        # The ``degraded`` flag in the envelope mirrors this choice so
        # the UI can surface a "warming up" banner during the
        # transition window.
        rows = self._fetch_chunks(
            parsed.text,
            filter_sql=filter_sql,
            limit=over_fetch,
        )

        # Aggregate to one row per node, then sort + slice the page.
        aggregated = self._aggregate_per_node(rows, parsed)
        ordered = self._sort_results(aggregated, request.sort)
        # Cross-encoder rerank: only meaningful when the user asked
        # for relevance order (sort=modified means "respect the
        # date", not "let the cross-encoder rerank by date").
        if request.sort == "relevance":
            ordered = self._apply_reranker(parsed.text, ordered)
        page = ordered[offset : offset + limit]
        next_cursor: str | None = None
        if offset + limit < len(ordered):
            next_cursor = f"{CURSOR_PREFIX}{offset + limit}"
        degraded = self._is_degraded()

        return SearchResponse(
            results=tuple(page),
            degraded=degraded,
            partial=None,
            state="ready",
            next_cursor=next_cursor,
        )

    def _fetch_chunks(
        self,
        text: str,
        *,
        filter_sql: str | None,
        limit: int,
    ) -> list[dict]:
        """Pick the lancedb retrieval path that matches the embedder.

        Hybrid is preferred when the embedder is semantic; on any
        embed-time failure we fall back to FTS-only with the same
        query. This keeps a transient model fault from killing search.
        """
        if not self._embedder.is_semantic:
            return self._store.fts_search(
                text, filter_sql=filter_sql, limit=limit
            )
        try:
            query_vecs = self._embedder.embed([text])
        except Exception as err:
            LOG.warning(
                "embedder failed for query %r: %s. Falling back to FTS.",
                text,
                err,
            )
            return self._store.fts_search(
                text, filter_sql=filter_sql, limit=limit
            )
        if not query_vecs:
            return self._store.fts_search(
                text, filter_sql=filter_sql, limit=limit
            )
        return self._store.hybrid_search(
            text,
            query_vecs[0],
            filter_sql=filter_sql,
            limit=limit,
        )

    # ----- internals ---------------------------------------------------

    def _is_degraded(self) -> bool:
        """``True`` while the embedder cannot produce semantic vectors.

        Reads the embedder's ``is_semantic`` property rather than an
        ``isinstance`` check so test doubles + future embedder
        implementations participate without modifying this module.
        """
        return not self._embedder.is_semantic

    def _aggregate_per_node(
        self,
        rows: list[dict],
        parsed: ParsedQuery,
    ) -> list[SearchResult]:
        """Group chunk rows by ``node_id``, keep MAX score, build the
        snippet from the highest-scoring chunk's text. The caller
        applies sort + offset + limit on top."""
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

        out: list[SearchResult] = []
        for r in best.values():
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
                    modified_at=_iso_or_none(r.get("modified_at")),
                )
            )
        return out

    def _apply_reranker(
        self,
        query: str,
        results: list[SearchResult],
    ) -> list[SearchResult]:
        """Cross-encoder rerank the top-N window in-place.

        ``rerank_window`` is the number of head results passed to the
        cross-encoder; entries beyond it keep their original order.
        Failures (model fault, shape mismatch) log + return the
        original ordering unchanged so a flaky reranker can never
        produce worse results than no reranker at all.
        """
        if self._reranker is None:
            return results
        if not query.strip() or not results:
            return results
        window = min(len(results), self._rerank_window)
        head = results[:window]
        tail = results[window:]
        # The reranker scores pairs of ``(query, document)``. Use
        # ``name + snippet`` so the cross-encoder sees both the title
        # signal and the matched-context signal.
        documents = [_doc_for_rerank(r) for r in head]
        try:
            scores = self._reranker.rerank(query, documents)
        except Exception as err:
            LOG.warning(
                "reranker failed: %s. Skipping rerank for this query.",
                err,
            )
            return results
        if len(scores) != len(head):
            LOG.warning(
                "reranker returned %d scores for %d candidates; skipping rerank",
                len(scores),
                len(head),
            )
            return results
        rescored = [
            replace(result, score=float(score))
            for result, score in zip(head, scores)
        ]
        rescored.sort(key=lambda r: r.score, reverse=True)
        return rescored + tail

    def _sort_results(
        self,
        results: list[SearchResult],
        sort: SortMode,
    ) -> list[SearchResult]:
        """Apply the user-selected sort. Falls back to relevance for
        any unrecognised mode (defensive — the Rust command validates
        the value, but the sidecar treats unknown modes as relevance
        rather than 400ing)."""
        if sort == "modified":
            # ``modified_at`` may be ``None`` when an older-version row
            # has no timestamp — sort those last by treating None as
            # the empty string (lexicographically before any ISO date).
            return sorted(
                results,
                key=lambda r: r.modified_at or "",
                reverse=True,
            )
        # default: relevance (descending score)
        return sorted(results, key=lambda r: r.score, reverse=True)


def _doc_for_rerank(result: SearchResult) -> str:
    """Build the document text the cross-encoder pairs with the query.

    ``name + snippet`` lets the model weigh both the title signal and
    the matched-context signal. Missing snippet falls back to name
    alone; the cross-encoder still produces a sensible score.
    """
    name = result.name or ""
    snippet = result.snippet or ""
    if name and snippet:
        return f"{name}: {snippet}"
    return name or snippet


def _decode_cursor(cursor: str | None) -> int:
    """Decode the v1 cursor token. Unknown / malformed values fall
    back to ``offset=0`` so an old client passing a stale cursor
    still gets a usable first page rather than an error."""
    if not cursor or not cursor.startswith(CURSOR_PREFIX):
        return 0
    try:
        offset = int(cursor[len(CURSOR_PREFIX) :])
    except ValueError:
        return 0
    if offset < 0:
        return 0
    # Cap absurd offsets so a malicious client can't force a 1M-row
    # FTS over-fetch.
    return min(offset, 5000)


def _iso_or_none(value) -> str | None:
    """Convert a lancedb timestamp value to ISO 8601 or ``None``.

    lancedb returns ``timestamp[ms]`` columns as ``datetime`` (or
    sometimes ``pandas.Timestamp``); both expose ``.isoformat()``.
    Strings pass through unchanged. Anything else becomes ``None``.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:
            return None
    return None


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
