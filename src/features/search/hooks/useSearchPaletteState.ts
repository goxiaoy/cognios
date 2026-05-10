import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildQueryString,
  EMPTY_FILTERS,
  type SearchFilters,
} from "../components/SearchFilterBar";
import type {
  SearchClient,
  SearchResponse,
  SearchSort,
  SidecarEnvelope,
} from "../types/search";

const DEBOUNCE_MS = 150;
// Page size when paging into deeper results via infinite scroll. The
// palette is now the only search surface (the dedicated view was
// removed in favour of folding filters + cursor pagination here),
// so the page size matches what the dedicated view used.
const PAGE_SIZE = 25;

export type PaletteEnvelopeState =
  | "idle"        // empty query; show recent-nodes placeholder
  | "loading"     // request in flight
  | "ready"       // results received
  | "loadingMore" // appending the next page
  | "initialising" // sidecar warming up
  | "unavailable"; // sidecar gone

export interface PaletteState {
  query: string;
  filters: SearchFilters;
  sort: SearchSort;
  envelopeState: PaletteEnvelopeState;
  results: SearchResponse["results"];
  degraded: boolean;
  nextCursor: string | null;
  error: string | null;
}

const INITIAL: PaletteState = {
  query: "",
  filters: EMPTY_FILTERS,
  sort: "relevance",
  envelopeState: "idle",
  results: [],
  degraded: false,
  nextCursor: null,
  error: null,
};

export function useSearchPaletteState(client: SearchClient) {
  const [state, setState] = useState<PaletteState>(INITIAL);
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingMoreRef = useRef(false);

  const setQuery = useCallback((next: string) => {
    setState((prev) => ({ ...prev, query: next }));
  }, []);

  const setFilters = useCallback((next: SearchFilters) => {
    setState((prev) => ({ ...prev, filters: next }));
  }, []);

  const setSort = useCallback((next: SearchSort) => {
    setState((prev) => ({ ...prev, sort: next }));
  }, []);

  // The composed query the sidecar parses — free text plus inline
  // ``kind:``, ``mount:``, ``modified:>=…`` operators built from the
  // structured filter object. Recomputed every render; cheap.
  const composedQuery = buildQueryString(state.query, state.filters);

  // Clean up any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (state.envelopeState !== "loadingMore") {
      loadingMoreRef.current = false;
    }
  }, [state.envelopeState]);

  // Debounced first-page search. Each new (query, filters, sort)
  // bumps `requestIdRef` so a stale response from a slower in-flight
  // call cannot overwrite a newer result list.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = composedQuery.trim();
    if (!trimmed) {
      setState((prev) => ({
        ...prev,
        envelopeState: "idle",
        results: [],
        degraded: false,
        nextCursor: null,
        error: null,
      }));
      return;
    }

    setState((prev) => ({ ...prev, envelopeState: "loading", error: null }));
    timerRef.current = setTimeout(async () => {
      const myRequestId = ++requestIdRef.current;
      let envelope: SidecarEnvelope<SearchResponse>;
      try {
        envelope = await client.search({
          query: trimmed,
          limit: PAGE_SIZE,
          sort: state.sort,
        });
      } catch (err) {
        if (myRequestId !== requestIdRef.current) return;
        setState((prev) => ({
          ...prev,
          envelopeState: "unavailable",
          results: [],
          nextCursor: null,
          error: err instanceof Error ? err.message : "Search failed",
        }));
        return;
      }
      if (myRequestId !== requestIdRef.current) return;

      if (envelope.state === "ready" && envelope.data) {
        setState((prev) => ({
          ...prev,
          envelopeState: "ready",
          results: envelope.data!.results,
          degraded: envelope.data?.degraded ?? false,
          nextCursor: envelope.data?.nextCursor ?? null,
          error: null,
        }));
      } else if (envelope.state === "initialising") {
        setState((prev) => ({
          ...prev,
          envelopeState: "initialising",
          results: [],
          nextCursor: null,
          error: null,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          envelopeState: "unavailable",
          results: [],
          nextCursor: null,
          error: envelope.error ?? "Search unavailable",
        }));
      }
    }, DEBOUNCE_MS);
  }, [client, composedQuery, state.sort]);

  // Pagination — appends the next page using the opaque cursor the
  // last response handed back. Concurrent first-page requests bump
  // ``requestIdRef``, so a load-more triggered against a stale
  // result set is naturally cancelled.
  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor) return;
    if (state.envelopeState === "loadingMore") return;
    if (loadingMoreRef.current) return;
    const trimmed = composedQuery.trim();
    if (!trimmed) return;

    loadingMoreRef.current = true;
    const myRequestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, envelopeState: "loadingMore" }));
    let envelope: SidecarEnvelope<SearchResponse>;
    try {
      envelope = await client.search({
        query: trimmed,
        limit: PAGE_SIZE,
        sort: state.sort,
        cursor,
      });
    } catch (err) {
      if (myRequestId !== requestIdRef.current) {
        loadingMoreRef.current = false;
        return;
      }
      setState((prev) => ({
        ...prev,
        envelopeState: "unavailable",
        error: err instanceof Error ? err.message : "Failed to load more",
      }));
      return;
    }
    if (myRequestId !== requestIdRef.current) {
      loadingMoreRef.current = false;
      return;
    }
    if (envelope.state === "ready" && envelope.data) {
      setState((prev) => ({
        ...prev,
        envelopeState: "ready",
        results: [...prev.results, ...envelope.data!.results],
        nextCursor: envelope.data?.nextCursor ?? null,
      }));
    } else {
      setState((prev) => ({
        ...prev,
        envelopeState: "ready",
        error: envelope.error ?? null,
      }));
    }
  }, [client, composedQuery, state.envelopeState, state.nextCursor, state.sort]);

  return { state, setQuery, setFilters, setSort, loadMore };
}

export const SEARCH_PALETTE_DEBOUNCE_MS = DEBOUNCE_MS;
export const SEARCH_PALETTE_PAGE_SIZE = PAGE_SIZE;
// Backwards-compatible alias for the old "result cap" sentinel still
// referenced by some tests / consumers; equals the page size now.
export const SEARCH_PALETTE_RESULT_CAP = PAGE_SIZE;
