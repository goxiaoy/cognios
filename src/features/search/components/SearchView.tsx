import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { ExplorerClient, ExplorerNode } from "../../explorer/types/explorer";
import { useExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import type { SearchClient, SearchResult, SearchSort } from "../types/search";
import {
  buildQueryString,
  collectMountNodes,
  EMPTY_FILTERS,
  SearchFilterBar,
  type SearchFilters,
} from "./SearchFilterBar";
import { SearchPreviewPane } from "./SearchPreviewPane";
import { SearchResultRow } from "./SearchResultRow";

const DEDICATED_PAGE_SIZE = 50;
const DEBOUNCE_MS = 200;

const ROW_ID = (idx: number) => `search-view-row-${idx}`;

/**
 * Cmd+Shift+F dedicated search view. Replaces the center pane while
 * the explorer tree on the left and the inspector on the right stay
 * interactive.
 *
 * Wire shape:
 * - The free-text input + structured filter bar build a single inline
 *   query string ("oauth kind:note,file mount:<uuid> modified:>=YYYY-MM-DD")
 *   that the Rust command + sidecar parser handle the same way as the
 *   palette.
 * - ``sort`` and ``cursor`` are separate IPC fields ("relevance" |
 *   "modified", and ``offset:N`` opaque token).
 * - Pagination is "Load more" only (no cursor URL exposure); each
 *   click appends the next page's results.
 *
 * Lifecycle:
 * - The dedicated view is owned by ``useExplorerStore`` (via
 *   ``activeSearchView``); SearchView consumes ``initialQuery`` from
 *   the store on mount and does not persist its working state on
 *   unmount. Closing + reopening starts fresh.
 */
export function SearchView({
  client,
  initialQuery,
  searchClient,
  onClose,
}: {
  client: ExplorerClient;
  initialQuery: string;
  searchClient: SearchClient;
  onClose(): void;
}) {
  const store = useExplorerStoreContext();
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SearchSort>("relevance");

  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  // Available mount choices — derived from the explorer snapshot so
  // the filter dropdown stays in sync with the workspace.
  const mounts = useMemo(
    () => collectMountNodes(store.snapshot.roots),
    [store.snapshot.roots]
  );

  // Selected result drives the preview pane.
  const selected: SearchResult | null = results[activeIndex] ?? null;
  const selectedNode: ExplorerNode | null = useMemo(() => {
    if (!selected) return null;
    return findNode(store.snapshot.roots, selected.nodeId);
  }, [selected, store.snapshot.roots]);

  const queryString = useMemo(
    () => buildQueryString(query, filters),
    [query, filters]
  );

  // Auto-focus the input when the view opens or the seed query changes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // First page — runs whenever the (debounced) query+filters+sort change.
  useEffect(() => {
    const trimmed = queryString.trim();
    if (!trimmed) {
      setResults([]);
      setNextCursor(null);
      setError(null);
      setDegraded(false);
      setIsLoading(false);
      return;
    }
    const myRequestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const env = await searchClient.search({
            query: trimmed,
            limit: DEDICATED_PAGE_SIZE,
            sort,
          });
          if (myRequestId !== requestIdRef.current) return;
          if (env.state === "ready" && env.data) {
            setResults(env.data.results);
            setNextCursor(env.data.nextCursor ?? null);
            setDegraded(env.data.degraded);
            setError(null);
          } else if (env.state === "initialising") {
            setResults([]);
            setNextCursor(null);
            setDegraded(false);
            setError("Search initialising — try again in a moment.");
          } else {
            setResults([]);
            setNextCursor(null);
            setDegraded(false);
            setError(env.error ?? "Search unavailable.");
          }
        } catch (cause) {
          if (myRequestId !== requestIdRef.current) return;
          setError(cause instanceof Error ? cause.message : "Search failed.");
          setResults([]);
          setNextCursor(null);
        } finally {
          if (myRequestId === requestIdRef.current) setIsLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryString, sort, searchClient]);

  // Reset active row whenever the result list shape changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [results.length]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isAppending) return;
    setIsAppending(true);
    setError(null);
    try {
      const env = await searchClient.search({
        query: queryString.trim(),
        limit: DEDICATED_PAGE_SIZE,
        sort,
        cursor: nextCursor,
      });
      if (env.state === "ready" && env.data) {
        setResults((prev) => [...prev, ...env.data!.results]);
        setNextCursor(env.data.nextCursor ?? null);
      } else {
        setError(env.error ?? "Failed to load more results.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load more.");
    } finally {
      setIsAppending(false);
    }
  }, [nextCursor, isAppending, queryString, sort, searchClient]);

  const handleResultActivate = useCallback(
    (idx: number, result: SearchResult) => {
      // Selecting a row in the dedicated view only previews — it does
      // *not* close the view (matches the plan's "preview pane that
      // selects-on-click" contract). To actually open the file in the
      // editor the user clicks the row in the tree, which closes
      // search via the store's activateArtifact.
      setActiveIndex(idx);
      void result;
    },
    []
  );

  return (
    <section className="search-view" aria-label="Search">
      <header className="search-view-header">
        <div className="search-view-input-row">
          <Search size={14} className="search-view-input-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Search across the workspace…"
            spellCheck={false}
            autoComplete="off"
            className="search-view-input"
            aria-label="Search query"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <button
            type="button"
            className="search-view-close"
            aria-label="Close search"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <SearchFilterBar
          filters={filters}
          sort={sort}
          mounts={mounts}
          onFiltersChange={setFilters}
          onSortChange={setSort}
        />
        {degraded ? (
          <p className="search-view-banner" role="status">
            Semantic search initialising — showing keyword matches.
          </p>
        ) : null}
        {error ? (
          <p className="search-view-error" role="status">
            {error}
          </p>
        ) : null}
      </header>

      <div className="search-view-body">
        <div className="search-view-results-pane">
          {isLoading ? (
            <p className="search-view-empty muted-copy" role="status">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="search-view-empty muted-copy">
              {queryString.trim() === ""
                ? "Type a query or apply a filter to begin."
                : "No matches."}
            </p>
          ) : (
            <ul
              role="listbox"
              className="search-view-results"
              aria-label="Search results"
            >
              {results.map((result, idx) => (
                <SearchResultRow
                  key={`${result.nodeId}-${idx}`}
                  result={result}
                  active={idx === activeIndex}
                  rowId={ROW_ID(idx)}
                  onActivate={() => handleResultActivate(idx, result)}
                  onHover={() => setActiveIndex(idx)}
                />
              ))}
            </ul>
          )}
          {nextCursor ? (
            <button
              type="button"
              className="search-view-load-more"
              disabled={isAppending}
              onClick={() => void loadMore()}
            >
              {isAppending ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
        <div className="search-view-preview-pane">
          <SearchPreviewPane node={selectedNode} client={client} />
        </div>
      </div>
    </section>
  );
}

function findNode(roots: ExplorerNode[], nodeId: string): ExplorerNode | null {
  for (const root of roots) {
    if (root.id === nodeId) return root;
    const found = findNode(root.children, nodeId);
    if (found) return found;
  }
  return null;
}
