import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SearchClient,
  SearchResponse,
  SidecarEnvelope,
} from "../types/search";

const DEBOUNCE_MS = 150;
const RESULT_CAP = 15;
// Sidecar returns up to N+1 to flag "more available"; the +1 is dropped
// from the rendered list and replaced with a "More results" affordance.
const OVER_FETCH = RESULT_CAP + 1;

export type PaletteEnvelopeState =
  | "idle"        // empty query; show recent-nodes placeholder
  | "loading"     // request in flight
  | "ready"       // results received
  | "initialising" // sidecar warming up
  | "unavailable"; // sidecar gone

export interface PaletteState {
  query: string;
  envelopeState: PaletteEnvelopeState;
  results: SearchResponse["results"];
  degraded: boolean;
  hasMore: boolean;
  error: string | null;
}

const INITIAL: PaletteState = {
  query: "",
  envelopeState: "idle",
  results: [],
  degraded: false,
  hasMore: false,
  error: null,
};

export function useSearchPaletteState(client: SearchClient) {
  const [state, setState] = useState<PaletteState>(INITIAL);
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setQuery = useCallback((next: string) => {
    setState((prev) => ({ ...prev, query: next }));
  }, []);

  // Clean up any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Debounced search. Each new query bumps `requestIdRef` so a stale
  // response from a slower in-flight call cannot overwrite a newer
  // result list.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const trimmed = state.query.trim();
    if (!trimmed) {
      setState((prev) => ({
        ...prev,
        envelopeState: "idle",
        results: [],
        degraded: false,
        hasMore: false,
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
          limit: OVER_FETCH,
        });
      } catch (err) {
        if (myRequestId !== requestIdRef.current) return;
        setState((prev) => ({
          ...prev,
          envelopeState: "unavailable",
          results: [],
          hasMore: false,
          error: err instanceof Error ? err.message : "Search failed",
        }));
        return;
      }
      if (myRequestId !== requestIdRef.current) return;

      if (envelope.state === "ready" && envelope.data) {
        const all = envelope.data.results;
        const visible = all.slice(0, RESULT_CAP);
        setState((prev) => ({
          ...prev,
          envelopeState: "ready",
          results: visible,
          degraded: envelope.data?.degraded ?? false,
          hasMore: all.length > RESULT_CAP,
          error: null,
        }));
      } else if (envelope.state === "initialising") {
        setState((prev) => ({
          ...prev,
          envelopeState: "initialising",
          results: [],
          hasMore: false,
          error: null,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          envelopeState: "unavailable",
          results: [],
          hasMore: false,
          error: envelope.error ?? "Search unavailable",
        }));
      }
    }, DEBOUNCE_MS);
  }, [client, state.query]);

  return { state, setQuery };
}

export const SEARCH_PALETTE_DEBOUNCE_MS = DEBOUNCE_MS;
export const SEARCH_PALETTE_RESULT_CAP = RESULT_CAP;
