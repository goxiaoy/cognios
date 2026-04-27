import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import { useRecentNodes } from "../hooks/useRecentNodes";
import {
  SEARCH_PALETTE_RESULT_CAP,
  useSearchPaletteState,
} from "../hooks/useSearchPaletteState";
import type { SearchClient, SearchResult } from "../types/search";
import { QuerySyntaxHelp } from "./QuerySyntaxHelp";
import { SearchResultRow } from "./SearchResultRow";

const LIST_ID = "search-palette-results";
const ROW_ID = (idx: number) => `search-palette-row-${idx}`;

/**
 * The Cmd+K palette.
 *
 * Renders as a global overlay; the App owns the open/close state and
 * mounts/unmounts this component. Internally tracks active-row and
 * the search lifecycle via :func:`useSearchPaletteState`.
 *
 * ARIA pattern: combobox + listbox. The input is the combobox, the
 * `<ul>` is the listbox, and each row is an option. ``aria-activedescendant``
 * tracks the keyboard-active row without moving DOM focus off the input —
 * keystrokes always go to the search field.
 */
export function SearchPalette({
  client,
  onClose,
  onActivate,
  onShowAll,
}: {
  client: SearchClient;
  onClose(): void;
  onActivate(): void;
  /**
   * Invoked when the user follows the "More results" affordance.
   * Carries the in-flight palette query forward so the dedicated
   * search view can seed its input field. Optional — when omitted,
   * the affordance still renders but does nothing on click (used by
   * tests that don't exercise navigation).
   */
  onShowAll?(query: string): void;
}) {
  const store = useExplorerStoreContext();
  const recentNodes = useRecentNodes();
  const { state, setQuery } = useSearchPaletteState(client);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Capture the previously focused element so Esc/close can restore it.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  // Reset the active row whenever the result list changes shape.
  useEffect(() => {
    setActiveIndex(0);
  }, [state.results, state.envelopeState, recentNodes]);

  // Build the list of items the keyboard navigates over. When the
  // query is empty we render the recent-nodes list; otherwise the
  // search results.
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

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  const activate = useCallback(
    (nodeId: string) => {
      store.activateArtifact(nodeId);
      onActivate();
      onClose();
    },
    [store, onActivate, onClose]
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
        if (item) activate(item.nodeId);
        return;
      }
    },
    [activate, activeIndex, close, navigableItems]
  );

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

        {state.degraded ? (
          <div className="search-palette-banner" role="status">
            Semantic search initialising — showing keyword matches.
          </div>
        ) : null}

        <PaletteBody
          state={state.envelopeState}
          error={state.error}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          activate={activate}
          recentNodes={recentNodes}
          results={state.results}
          hasMore={state.hasMore}
          onShowAll={
            onShowAll ? () => onShowAll(state.query) : undefined
          }
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

function PaletteBody({
  state,
  error,
  activeIndex,
  setActiveIndex,
  activate,
  recentNodes,
  results,
  hasMore,
  onShowAll,
}: {
  state: "idle" | "loading" | "ready" | "initialising" | "unavailable";
  error: string | null;
  activeIndex: number;
  setActiveIndex(idx: number): void;
  activate(nodeId: string): void;
  recentNodes: ReturnType<typeof useRecentNodes>;
  results: SearchResult[];
  hasMore: boolean;
  onShowAll?: () => void;
}) {
  if (state === "idle") {
    if (recentNodes.length === 0) {
      return (
        <div className="search-palette-empty muted-copy">
          Start typing to search across notes, URLs, and mounted files.
        </div>
      );
    }
    return (
      <>
        <p className="search-palette-list-eyebrow">Recently modified</p>
        <ul
          id={LIST_ID}
          role="listbox"
          className="search-palette-list"
          aria-label="Recently modified"
        >
          {recentNodes.map((node, idx) => (
            <li
              key={node.id}
              id={ROW_ID(idx)}
              role="option"
              aria-selected={idx === activeIndex}
              className={`search-result-row${idx === activeIndex ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => activate(node.id)}
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

  // ready
  if (results.length === 0) {
    return (
      <div className="search-palette-empty muted-copy">No matches.</div>
    );
  }

  return (
    <>
      <ul
        id={LIST_ID}
        role="listbox"
        className="search-palette-list"
        aria-label="Search results"
      >
        {results.map((result, idx) => (
          <SearchResultRow
            key={`${result.nodeId}-${idx}`}
            result={result}
            active={idx === activeIndex}
            rowId={ROW_ID(idx)}
            onActivate={() => activate(result.nodeId)}
            onHover={() => setActiveIndex(idx)}
          />
        ))}
      </ul>
      {hasMore ? (
        onShowAll ? (
          <button
            type="button"
            className="search-palette-more search-palette-more-button"
            onClick={onShowAll}
          >
            More results in dedicated view (⇧⌘F)
          </button>
        ) : (
          <div className="search-palette-more muted-copy">
            More results in dedicated view (⇧⌘F).
          </div>
        )
      ) : null}
    </>
  );
}

function liveRegionMessage(
  state: "idle" | "loading" | "ready" | "initialising" | "unavailable",
  count: number
): string {
  switch (state) {
    case "idle":
      return count > 0 ? `${count} recent items` : "";
    case "loading":
      return "Searching";
    case "ready":
      return count === 0 ? "No matches" : `${count} ${count === 1 ? "result" : "results"}`;
    case "initialising":
      return "Search initialising";
    case "unavailable":
      return "Search unavailable";
  }
}

// Sentinel — exposes the result cap so tests can assert the slice
// applied by useSearchPaletteState.
export const SEARCH_PALETTE_VISIBLE_CAP = SEARCH_PALETTE_RESULT_CAP;
