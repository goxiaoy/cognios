import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeDashboard } from "./HomeDashboard";
import type { SearchClient } from "../../search/types/search";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

afterEach(() => {
  cleanup();
});

function makeClient(): SearchClient {
  return {
    search: vi.fn(),
    indexStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        queueDepth: 2,
        inFlight: ["n1"],
        enhancementInFlight: ["n2"],
        indexedChunks: 1234,
        enhancementPending: 1,
        enhancementFailed: 0,
        enhancementTotalImages: 4,
      },
    }),
    observability: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        recentIndexedNodes: [
          { date: "2026-05-09", count: 1 },
          { date: "2026-05-10", count: 3 },
        ],
        latency: {
          search: { sampleCount: 2, failureCount: 0, latestMs: 20, p50Ms: 10, p90Ms: 18, p99Ms: 20 },
          indexing: { sampleCount: 1, failureCount: 0, latestMs: 44, p50Ms: 44, p90Ms: 44, p99Ms: 44 },
          enhancement: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
          modelDownload: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
        },
        tokenUsage: [
          {
            providerId: "local-ollama",
            model: "llama3",
            requests: 1,
            promptTokens: 12,
            completionTokens: 8,
            totalTokens: 20,
          },
        ],
      },
    }),
    nodeIndexStatus: vi.fn(),
    nodeContent: vi.fn(),
    modelsStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        roles: {
          embedding: { role: "embedding", state: "ready", repo: "" },
          "advanced-ocr-layout": {
            role: "advanced-ocr-layout",
            state: "ready",
            repo: "",
          },
        },
      },
    }),
    startModelDownload: vi.fn(),
    settings: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        version: 1,
        providers: { "local-gte": { providerId: "local-gte", enabled: true, modelPerCapability: {} } },
        features: {},
        cloudConsentAcked: [],
        firstRunSkipped: false,
        needsRestart: false,
      },
    }),
    updateSettings: vi.fn(),
    restartSidecar: vi.fn(),
    readSettingsFallback: vi.fn(),
    setProviderSecret: vi.fn(),
    hasProviderSecret: vi.fn(),
    deleteProviderSecret: vi.fn(),
    testChatProvider: vi.fn(),
  };
}

describe("HomeDashboard", () => {
  it("renders current status, activity, latency, and token usage", async () => {
    const client = makeClient();
    render(<HomeDashboard client={client} />);

    expect(await screen.findByText("Indexed items")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
    expect(screen.queryByText("Model roles")).not.toBeInTheDocument();
    expect(screen.queryByText("Engines")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Recent indexing")).toBeInTheDocument();
      expect(screen.getByText("P90 18 ms")).toBeInTheDocument();
      expect(screen.getByText("llama3")).toBeInTheDocument();
      expect(screen.getByText("20")).toBeInTheDocument();
    });
    expect(client.observability).toHaveBeenCalledWith({ recentDays: 30 });
    expect(client.settings).not.toHaveBeenCalled();
  });

  it("reloads recent indexing when the range changes", async () => {
    const client = makeClient();
    render(<HomeDashboard client={client} />);

    await waitFor(() => {
      expect(client.observability).toHaveBeenCalledWith({ recentDays: 30 });
    });

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => {
      expect(client.observability).toHaveBeenCalledWith({ recentDays: 7 });
    });
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
