import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { searchClient } from "./searchClient";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import type {
  IndexStatus,
  IndexStatistics,
  ModelsStatus,
  SearchObservability,
  SearchResponse,
  SidecarEnvelope,
} from "../types/search";

const mockedInvoke = vi.mocked(invoke);

afterEach(() => {
  mockedInvoke.mockReset();
});

describe("searchClient.search", () => {
  it("forwards the input to invoke under search_query", async () => {
    const ready: SidecarEnvelope<SearchResponse> = {
      state: "ready",
      data: { results: [], degraded: true, partial: null, state: "ready" },
    };
    mockedInvoke.mockResolvedValueOnce(ready);

    const result = await searchClient.search({ query: "PKCE" });

    expect(mockedInvoke).toHaveBeenCalledWith("search_query", {
      input: { query: "PKCE" },
    });
    expect(result).toBe(ready);
  });

  it("propagates initialising envelope without throwing", async () => {
    const env: SidecarEnvelope<SearchResponse> = { state: "initialising" };
    mockedInvoke.mockResolvedValueOnce(env);

    const result = await searchClient.search({ query: "x" });
    expect(result.state).toBe("initialising");
    expect(result.data).toBeUndefined();
  });

  it("supports an optional limit argument", async () => {
    mockedInvoke.mockResolvedValueOnce({ state: "ready", data: { results: [], degraded: true } });

    await searchClient.search({ query: "x", limit: 5 });

    expect(mockedInvoke).toHaveBeenCalledWith("search_query", {
      input: { query: "x", limit: 5 },
    });
  });
});

describe("searchClient.indexStatus", () => {
  it("calls get_indexing_status and returns the envelope", async () => {
    const env: SidecarEnvelope<IndexStatus> = {
      state: "ready",
      data: {
        inFlight: ["abc"],
        enhancementInFlight: [],
        indexedChunks: 100,
        enhancementPending: 0,
        enhancementFailed: 0,
        enhancementTotalImages: 0,
      },
    };
    mockedInvoke.mockResolvedValueOnce(env);

    const result = await searchClient.indexStatus();
    expect(mockedInvoke).toHaveBeenCalledWith("get_indexing_status");
    expect(result.data?.indexedChunks).toBe(100);
  });
});

describe("searchClient.indexStatistics", () => {
  it("calls get_index_statistics and returns local statistics", async () => {
    const stats: IndexStatistics = {
      recentIndexedNodes: [{ date: "2026-05-10", count: 3 }],
    };
    mockedInvoke.mockResolvedValueOnce(stats);

    const result = await searchClient.indexStatistics({ recentDays: 7 });

    expect(mockedInvoke).toHaveBeenCalledWith("get_index_statistics", {
      input: { recentDays: 7 },
    });
    expect(result.recentIndexedNodes[0].count).toBe(3);
  });
});

describe("searchClient.observability", () => {
  it("calls get_search_observability and returns the envelope", async () => {
    const env: SidecarEnvelope<SearchObservability> = {
      state: "ready",
      data: {
        recentIndexedNodes: [{ date: "2026-05-10", count: 3 }],
        latency: {
          search: { sampleCount: 1, failureCount: 0, latestMs: 12, p50Ms: 12, p90Ms: 12, p99Ms: 12 },
          indexing: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
          enhancement: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
          modelDownload: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
        },
        tokenUsage: [],
      },
    };
    mockedInvoke.mockResolvedValueOnce(env);

    const result = await searchClient.observability({ recentDays: 7 });
    expect(mockedInvoke).toHaveBeenCalledWith("get_search_observability", {
      input: { recentDays: 7 },
    });
    expect(result.data?.recentIndexedNodes[0].count).toBe(3);
  });
});

describe("searchClient.modelsStatus", () => {
  it("returns the four-role status block", async () => {
    const env: SidecarEnvelope<ModelsStatus> = {
      state: "ready",
      data: {
        roles: {
          embedding: {
            role: "embedding",
            state: "missing",
            repo: "",
            commit: null,
            error: null,
          },
        },
      },
    };
    mockedInvoke.mockResolvedValueOnce(env);

    const result = await searchClient.modelsStatus();
    expect(result.data?.roles.embedding.state).toBe("missing");
  });
});

describe("searchClient.testChatProvider", () => {
  it("forwards provider probe input to invoke", async () => {
    mockedInvoke.mockResolvedValueOnce({
      result: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [],
          cached: false,
          warnings: [],
        },
      },
    });

    await searchClient.testChatProvider({
      providerId: "local-ollama",
      baseUrl: "http://localhost:11435",
    });

    expect(mockedInvoke).toHaveBeenCalledWith("test_chat_provider", {
      input: {
        providerId: "local-ollama",
        baseUrl: "http://localhost:11435",
      },
    });
  });
});

describe("unwrapEnvelope", () => {
  it("returns data on ready", () => {
    expect(unwrapEnvelope({ state: "ready", data: 42 })).toBe(42);
  });
  it("returns null on initialising", () => {
    expect(unwrapEnvelope({ state: "initialising" })).toBeNull();
  });
  it("returns null on unavailable", () => {
    expect(unwrapEnvelope({ state: "unavailable", error: "x" })).toBeNull();
  });
  it("returns null when ready but data missing (defensive)", () => {
    expect(unwrapEnvelope({ state: "ready" })).toBeNull();
  });
});
