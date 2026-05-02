import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTERS } from "../components/SearchFilterBar";
import {
  SEARCH_PALETTE_DEBOUNCE_MS,
  SEARCH_PALETTE_PAGE_SIZE,
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
    startModelDownload: vi.fn(),
    nodeContent: vi.fn(),
    settings: vi.fn().mockResolvedValue({ state: "initialising" }),
    updateSettings: vi.fn().mockResolvedValue({ state: "initialising" }),
    restartSidecar: vi.fn().mockResolvedValue(undefined),
    readSettingsFallback: vi.fn().mockResolvedValue({
      version: 1,
      providers: {},
      features: {},
      cloudConsentAcked: [],
      firstRunSkipped: false,
      needsRestart: false,
    }),
    setProviderSecret: vi.fn().mockResolvedValue(undefined),
    hasProviderSecret: vi.fn().mockResolvedValue(false),
    deleteProviderSecret: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function readyEnv(
  results: SearchResponse["results"] = [],
  degraded = true,
  nextCursor: string | null = null
): SidecarEnvelope<SearchResponse> {
  return {
    state: "ready",
    data: { results, degraded, partial: null, state: "ready", nextCursor },
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
  it("starts in idle state with no results, default filters, and relevance sort", () => {
    const client = makeClient();
    const { result } = renderHook(() => useSearchPaletteState(client));
    expect(result.current.state.envelopeState).toBe("idle");
    expect(result.current.state.results).toEqual([]);
    expect(result.current.state.filters).toEqual(EMPTY_FILTERS);
    expect(result.current.state.sort).toBe("relevance");
    expect(client.search).not.toHaveBeenCalled();
  });

  it("does not call search for an empty/whitespace query when no filters are set", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useSearchPaletteState(client));
    act(() => {
      result.current.setQuery("   ");
    });
    await new Promise((r) => setTimeout(r, PAST_DEBOUNCE_MS));
    expect(client.search).not.toHaveBeenCalled();
    expect(result.current.state.envelopeState).toBe("idle");
  });

  it("debounces search and forwards the composed query past the debounce window", async () => {
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
      limit: SEARCH_PALETTE_PAGE_SIZE,
      sort: "relevance",
    });
    expect(result.current.state.results).toHaveLength(1);
  });

  it("re-issues the search when filters change, with inline-syntax composed query", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv([])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("oauth");
    });
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.setFilters({ ...EMPTY_FILTERS, kinds: ["note", "url"] });
    });
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(2);
    });
    expect(client.search).toHaveBeenLastCalledWith({
      query: "oauth kind:note,url",
      limit: SEARCH_PALETTE_PAGE_SIZE,
      sort: "relevance",
    });
  });

  it("forwards the chosen sort", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv([])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));

    act(() => {
      result.current.setQuery("oauth");
    });
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(1);
    });
    act(() => {
      result.current.setSort("modified");
    });
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(2);
    });
    expect(client.search).toHaveBeenLastCalledWith({
      query: "oauth",
      limit: SEARCH_PALETTE_PAGE_SIZE,
      sort: "modified",
    });
  });

  it("triggers a search when only a filter is set (no free-text query)", async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue(readyEnv([])),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));
    act(() => {
      result.current.setFilters({ ...EMPTY_FILTERS, kinds: ["note"] });
    });
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(1);
    });
    expect(client.search).toHaveBeenLastCalledWith({
      query: "kind:note",
      limit: SEARCH_PALETTE_PAGE_SIZE,
      sort: "relevance",
    });
  });

  it("exposes nextCursor when more results remain", async () => {
    const client = makeClient({
      search: vi
        .fn()
        .mockResolvedValue(readyEnv([makeResult(0)], false, "offset:25")),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));
    act(() => {
      result.current.setQuery("rotate");
    });
    await waitFor(() => {
      expect(result.current.state.envelopeState).toBe("ready");
    });
    expect(result.current.state.nextCursor).toBe("offset:25");
  });

  it("loadMore appends the next page and updates the cursor", async () => {
    let call = 0;
    const client = makeClient({
      search: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            readyEnv([makeResult(0)], false, "offset:25")
          );
        }
        return Promise.resolve(readyEnv([makeResult(1)], false, null));
      }),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));
    act(() => {
      result.current.setQuery("rotate");
    });
    await waitFor(() => {
      expect(result.current.state.results).toHaveLength(1);
    });
    await act(async () => {
      await result.current.loadMore();
    });
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(client.search).toHaveBeenLastCalledWith({
      query: "rotate",
      limit: SEARCH_PALETTE_PAGE_SIZE,
      sort: "relevance",
      cursor: "offset:25",
    });
    expect(result.current.state.results).toHaveLength(2);
    expect(result.current.state.nextCursor).toBeNull();
  });

  it("loadMore is a no-op when no cursor is set", async () => {
    const client = makeClient({
      search: vi.fn(),
    });
    const { result } = renderHook(() => useSearchPaletteState(client));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(client.search).not.toHaveBeenCalled();
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

  it("clears results when the query is cleared and no filters remain", async () => {
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
