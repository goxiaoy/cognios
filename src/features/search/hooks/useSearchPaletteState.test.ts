import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SEARCH_PALETTE_DEBOUNCE_MS,
  SEARCH_PALETTE_RESULT_CAP,
  useSearchPaletteState,
} from "./useSearchPaletteState";
import type {
  SearchClient,
  SearchResponse,
  SidecarEnvelope,
} from "../types/search";

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn(),
    indexStatus: vi.fn(),
    nodeIndexStatus: vi.fn(),
    modelsStatus: vi.fn(),
    acceptModelLicense: vi.fn(),
    ...overrides,
  };
}

function readyEnv(
  results: SearchResponse["results"] = [],
  degraded = true
): SidecarEnvelope<SearchResponse> {
  return {
    state: "ready",
    data: { results, degraded, partial: null, state: "ready" },
  };
}

function makeResult(idx: number) {
  return {
    nodeId: `node-${idx}`,
    kind: "note" as const,
    name: `Note ${idx}`,
    score: 1 - idx * 0.01,
    snippet: `snippet ${idx}`,
    matchedIn: "content" as const,
  };
}

const PAST_DEBOUNCE_MS = SEARCH_PALETTE_DEBOUNCE_MS + 50;

afterEach(() => {
  vi.useRealTimers();
});

describe("useSearchPaletteState", () => {
  it("starts in idle state with no results", () => {
    const client = makeClient();
    const { result } = renderHook(() => useSearchPaletteState(client));
    expect(result.current.state.envelopeState).toBe("idle");
    expect(result.current.state.results).toEqual([]);
    expect(client.search).not.toHaveBeenCalled();
  });

  it("does not call search for an empty/whitespace query", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useSearchPaletteState(client));
    act(() => {
      result.current.setQuery("   ");
    });
    await new Promise((r) => setTimeout(r, PAST_DEBOUNCE_MS));
    expect(client.search).not.toHaveBeenCalled();
    expect(result.current.state.envelopeState).toBe("idle");
  });

  it("debounces search and forwards the query past the debounce window", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv([makeResult(0)])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("oauth");
    });

    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("ready");
    });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith({
      query: "oauth",
      limit: SEARCH_PALETTE_RESULT_CAP + 1,
    });
    expect(result.current.state.results).toHaveLength(1);
  });

  it("trims results to the visible cap and reports hasMore", async () => {
    const overflow = Array.from(
      { length: SEARCH_PALETTE_RESULT_CAP + 1 },
      (_, i) => makeResult(i)
    );
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv(overflow, false)),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("rotate");
    });

    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("ready");
    });
    expect(result.current.state.results).toHaveLength(SEARCH_PALETTE_RESULT_CAP);
    expect(result.current.state.hasMore).toBe(true);
    expect(result.current.state.degraded).toBe(false);
  });

  it("forwards initialising envelope state", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue({ state: "initialising" }),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("x");
    });

    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("initialising");
    });
    expect(result.current.state.results).toEqual([]);
  });

  it("forwards unavailable envelope state with error message", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue({
        state: "unavailable",
        error: "sidecar gone",
      }),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("x");
    });

    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("unavailable");
    });
    expect(result.current.state.error).toBe("sidecar gone");
  });

  it("clears results when the query is cleared", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv([makeResult(0)])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("oauth");
    });
    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("ready");
    });

    act(() => {
      result.current.setQuery("");
    });

    expect(result.current.state.envelopeState).toBe("idle");
    expect(result.current.state.results).toEqual([]);
  });

  it("ignores stale responses when a newer query is in flight", async () => {
    let resolveOld: ((env: SidecarEnvelope<SearchResponse>) => void) | null = null;
    const oldPromise = new Promise<SidecarEnvelope<SearchResponse>>((resolve) => {
      resolveOld = resolve;
    });
    const client = makeClient({
      search: vi
        .fn()
        .mockReturnValueOnce(oldPromise)
        .mockResolvedValueOnce(readyEnv([makeResult(99)])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    // Kick off the first query, wait through the debounce.
    act(() => {
      result.current.setQuery("first");
    });
    await new Promise((r) => setTimeout(r, PAST_DEBOUNCE_MS));
    expect(client.search).toHaveBeenCalledTimes(1);

    // Replace before the first call resolves.
    act(() => {
      result.current.setQuery("second");
    });
    await waitFor(() => {
      expect(result.current.state.results).toEqual([makeResult(99)]);
    });

    // Now resolve the stale first call. The "second" results must
    // remain.
    await act(async () => {
      resolveOld?.(readyEnv([makeResult(0)]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state.results).toEqual([makeResult(99)]);
  });
});
