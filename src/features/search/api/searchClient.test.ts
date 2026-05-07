import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { searchClient } from "./searchClient";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import type {
  IndexStatus,
  ModelsStatus,
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
        queueDepth: 3,
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
    expect(result.data?.queueDepth).toBe(3);
  });
});

describe("searchClient.nodeIndexStatus", () => {
  it("forwards the node id under input.nodeId", async () => {
    mockedInvoke.mockResolvedValueOnce({
      state: "ready",
      data: {
        nodeId: "abc",
        state: "indexed",
        attempts: 1,
        indexedAt: "2026-04-27T00:00:00Z",
        error: null,
      },
    });
    await searchClient.nodeIndexStatus("abc");
    expect(mockedInvoke).toHaveBeenCalledWith("get_node_indexing_status", {
      input: { nodeId: "abc" },
    });
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
