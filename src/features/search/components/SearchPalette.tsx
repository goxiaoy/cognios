import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { useExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import { useRecentNodes } from "../hooks/useRecentNodes";
import {
  SEARCH_PALETTE_PAGE_SIZE,
  useSearchPaletteState,
} from "../hooks/useSearchPaletteState";
import type { SearchClient, SearchResult } from "../types/search";
import { QuerySyntaxHelp } from "./QuerySyntaxHelp";
import {
  collectMountNodes,
  EMPTY_FILTERS,
  SearchFilterBar,
} from "./SearchFilterBar";
import { SearchResultRow } from "./SearchResultRow";

const LIST_ID = "search-palette-results";
const ROW_ID = (idx: number) => `search-palette-row-${idx}`;

/**
 * The Cmd+K palette — the only search surface in the app. Holds the
 * free-text query, the structured filter bar (kind chips, mount
 * picker, modified-date inputs, sort dropdown), and the result list
 * with cursor-based infinite scroll pagination.
 *
 * Filters and free text both flow into the same composed query
 * string via :func:`buildQueryString`, so the sidecar parses one
 * inline-syntax form regardless of how the user supplied operators.
 *
 * ARIA pattern: combobox + listbox. The input is the combobox; the
 * `<ul>` is the listbox; rows are options.
 * ``aria-activedescendant`` tracks the keyboard-active row without
 * moving DOM focus off the input — keystrokes always go to the
 * search field.
 */
export function SearchPalette({
  client,
  onClose,
  onActivate,
  onSelectNode,
}: {
  client: SearchClient;
  onClose(): void;
  onActivate(): void;
  onSelectNode?(node: SearchPaletteSelection): void;
}) {
  const store = useExplorerStoreContext();
  const recentNodes = useRecentNodes();
  const { state, setQuery, setFilters, setSort, loadMore } =
    useSearchPaletteState(client);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);

  // Capture the previously focused element so Esc/close can restore it.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  // Mount choices for the filter bar — derived from the explorer
  // snapshot so the picker stays in sync with the workspace.
  const mounts = useMemo(
    () => collectMountNodes(store.snapshot.roots),
    [store.snapshot.roots]
  );

  // Build the list of items the keyboard navigates over. When the
  // query is empty (and no filters are applied) we render the
  // recent-nodes list; otherwise the search results.
  const navigableItems: NavigableItem[] = useMemo(() => {
    if (state.envelopeState === "idle") {
      return recentNodes.map((node) => ({
        kind: "recent" as const,
        nodeId: node.id,
        label: node.name,
      }));
    }
    return state.results.map((result) => ({
      kind: "result" as const,
      nodeId: result.nodeId,
      label: result.name,
      result,
    }));
  }, [state.envelopeState, state.results, recentNodes]);

  // Reset the active row whenever the result list changes shape. If
  // the pointer is still over the list, keep visual focus under it so
  // result refreshes don't leave two apparent targets.
  useEffect(() => {
    const hoveredIndex = hoveredIndexRef.current;
    setActiveIndex(
      hoveredIndex !== null && hoveredIndex < navigableItems.length
        ? hoveredIndex
        : 0
    );
  }, [navigableItems]);

  const hoverRow = useCallback((idx: number) => {
    hoveredIndexRef.current = idx;
    setActiveIndex(idx);
  }, []);

  const clearHoveredRow = useCallback(() => {
    hoveredIndexRef.current = null;
  }, []);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  const activate = useCallback(
    (item: NavigableItem) => {
      if (onSelectNode) {
        onSelectNode(selectionFromItem(item));
        onClose();
        return;
      }
      store.activateArtifact(item.nodeId);
      onActivate();
      onClose();
    },
    [store, onActivate, onClose, onSelectNode]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (navigableItems.length === 0) return;
        setActiveIndex((idx) => (idx + 1) % navigableItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (navigableItems.length === 0) return;
        setActiveIndex(
          (idx) => (idx - 1 + navigableItems.length) % navigableItems.length
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = navigableItems[activeIndex];
        if (item) activate(item);
        return;
      }
    },
    [activate, activeIndex, close, navigableItems]
  );

  const filtersActive =
    state.filters.kinds.length > 0 ||
    state.filters.mountId !== null ||
    state.filters.modifiedAfter !== null ||
    state.filters.modifiedBefore !== null;
  const filterCount =
    state.filters.kinds.length +
    (state.filters.mountId ? 1 : 0) +
    (state.filters.modifiedAfter ? 1 : 0) +
    (state.filters.modifiedBefore ? 1 : 0);

  function handleClearFilters() {
    setFilters(EMPTY_FILTERS);
    setSort("relevance");
  }

  return (
    <div
      className="search-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
      >
        <div className="search-palette-input-row">
          <Search className="search-palette-input-icon" size={14} aria-hidden="true" />
          <input
            ref={inputRef}
            className="search-palette-input"
            type="text"
            value={state.query}
            placeholder="Search notes, URLs, files…"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={navigableItems.length > 0}
            aria-controls={LIST_ID}
            aria-activedescendant={
              navigableItems.length > 0 ? ROW_ID(activeIndex) : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            className={`search-palette-filter-toggle${filtersOpen ? " is-open" : ""}${filtersActive ? " has-active" : ""}`}
            aria-pressed={filtersOpen}
            aria-label={filtersOpen ? "Hide filters" : "Show filters"}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {filterCount > 0 ? (
              <span className="search-palette-filter-count" aria-hidden="true">
                {filterCount}
              </span>
            ) : null}
          </button>
          <QuerySyntaxHelp />
          <button
            type="button"
            className="search-palette-close"
            aria-label="Close search"
            onClick={close}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        {filtersOpen ? (
          <div className="search-palette-filters">
            <SearchFilterBar
              filters={state.filters}
              sort={state.sort}
              mounts={mounts}
              onFiltersChange={setFilters}
              onSortChange={setSort}
            />
            {filtersActive ? (
              <button
                type="button"
                className="search-palette-filter-clear"
                onClick={handleClearFilters}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}

        {state.degraded ? (
          <div className="search-palette-banner" role="status">
            Semantic search initialising — showing keyword matches.
          </div>
        ) : null}

        <PaletteBody
          state={state.envelopeState}
          error={state.error}
          activeIndex={activeIndex}
          onRowHover={hoverRow}
          onListMouseLeave={clearHoveredRow}
          activate={activate}
          recentNodes={recentNodes}
          results={state.results}
          hasMore={state.nextCursor !== null}
          onLoadMore={() => void loadMore()}
        />

        <span className="visually-hidden" aria-live="polite">
          {liveRegionMessage(state.envelopeState, navigableItems.length)}
        </span>
      </div>
    </div>
  );
}

type NavigableItem =
  | { kind: "recent"; nodeId: string; label: string }
  | { kind: "result"; nodeId: string; label: string; result: SearchResult };

export interface SearchPaletteSelection {
  nodeId: string;
  name: string;
  kind?: string | null;
  path?: string | null;
  snippet?: string | null;
}

function PaletteBody({
  state,
  error,
  activeIndex,
  onRowHover,
  onListMouseLeave,
  activate,
  recentNodes,
  results,
  hasMore,
  onLoadMore,
}: {
  state:
    | "idle"
    | "loading"
    | "ready"
    | "loadingMore"
    | "initialising"
    | "unavailable";
  error: string | null;
  activeIndex: number;
  onRowHover(idx: number): void;
  onListMouseLeave(): void;
  activate(item: NavigableItem): void;
  recentNodes: ReturnType<typeof useRecentNodes>;
  results: SearchResult[];
  hasMore: boolean;
  onLoadMore(): void;
}) {
  if (state === "idle") {
    if (recentNodes.length === 0) {
      return (
        <div className="search-palette-empty muted-copy">
          Start typing or apply a filter to search across notes, URLs, and
          mounted files.
        </div>
      );
    }
    return (
      <>
        <p className="search-palette-list-eyebrow">Recently modified</p>
        <div className="search-palette-scroll">
          <ul
            id={LIST_ID}
            role="listbox"
            className="search-palette-list"
            aria-label="Recently modified"
            onMouseLeave={onListMouseLeave}
          >
            {recentNodes.map((node, idx) => (
              <li
                key={node.id}
                id={ROW_ID(idx)}
                role="option"
                aria-selected={idx === activeIndex}
                className={`search-result-row${idx === activeIndex ? " is-active" : ""}`}
                onMouseEnter={() => onRowHover(idx)}
                onClick={() =>
                  activate({
                    kind: "recent",
                    nodeId: node.id,
                    label: node.name,
                  })
                }
              >
                <span className="search-result-body">
                  <span className="search-result-title">
                    <span className="search-result-name">{node.name}</span>
                    <span className="search-result-kind">{node.kind}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  if (state === "loading") {
    return (
      <div className="search-palette-empty muted-copy" role="status">
        Searching…
      </div>
    );
  }

  if (state === "initialising") {
    return (
      <div className="search-palette-empty muted-copy" role="status">
        Search initialising — try again in a moment.
      </div>
    );
  }

  if (state === "unavailable") {
    return (
      <div className="search-palette-empty search-palette-error" role="status">
        {error ?? "Search unavailable."}
      </div>
    );
  }

  // ready or loadingMore
  if (results.length === 0) {
    return (
      <div className="search-palette-empty muted-copy">No matches.</div>
    );
  }

  return (
    <div
      className="search-palette-scroll"
      onScroll={(event) => {
        if (!hasMore || state === "loadingMore") return;
        const target = event.currentTarget;
        const remaining =
          target.scrollHeight - target.scrollTop - target.clientHeight;
        if (remaining <= 48) onLoadMore();
      }}
    >
      <ul
        id={LIST_ID}
        role="listbox"
        className="search-palette-list"
        aria-label="Search results"
        onMouseLeave={onListMouseLeave}
      >
        {results.map((result, idx) => (
          <SearchResultRow
            key={`${result.nodeId}-${idx}`}
            result={result}
            active={idx === activeIndex}
            rowId={ROW_ID(idx)}
            onActivate={() =>
              activate({
                kind: "result",
                nodeId: result.nodeId,
                label: result.name,
                result,
              })
            }
            onHover={() => onRowHover(idx)}
          />
        ))}
      </ul>
      {state === "loadingMore" || !hasMore ? (
        <p className="search-palette-more" role="status">
          {state === "loadingMore" ? "Loading more..." : "No more results."}
        </p>
      ) : null}
    </div>
  );
}

function selectionFromItem(item: NavigableItem): SearchPaletteSelection {
  if (item.kind === "result") {
    return {
      nodeId: item.result.nodeId,
      name: item.result.name,
      kind: item.result.kind,
      path: item.result.path ?? null,
      snippet: item.result.snippet,
    };
  }
  return {
    nodeId: item.nodeId,
    name: item.label,
  };
}

function liveRegionMessage(
  state:
    | "idle"
    | "loading"
    | "ready"
    | "loadingMore"
    | "initialising"
    | "unavailable",
  count: number
): string {
  switch (state) {
    case "idle":
      return count > 0 ? `${count} recent items` : "";
    case "loading":
      return "Searching";
    case "loadingMore":
      return "Loading more results";
    case "ready":
      return count === 0 ? "No matches" : `${count} ${count === 1 ? "result" : "results"}`;
    case "initialising":
      return "Search initialising";
    case "unavailable":
      return "Search unavailable";
  }
}

// Sentinel — exposes the page size so tests can assert it.
export const SEARCH_PALETTE_VISIBLE_CAP = SEARCH_PALETTE_PAGE_SIZE;
