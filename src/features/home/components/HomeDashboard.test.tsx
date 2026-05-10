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
        latencyTrends: {
          search: [
            { bucket: "2026-05-09", sampleCount: 1, failureCount: 0, p50Ms: 10, p90Ms: 12, p99Ms: 12 },
            { bucket: "2026-05-10", sampleCount: 1, failureCount: 0, p50Ms: 14, p90Ms: 18, p99Ms: 20 },
          ],
          indexing: [
            { bucket: "2026-05-10", sampleCount: 1, failureCount: 0, p50Ms: 44, p90Ms: 44, p99Ms: 44 },
          ],
          enhancement: [],
          modelDownload: [],
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
        tokenUsageByDay: [
          {
            date: "2026-05-09",
            totalTokens: 0,
            segments: [],
          },
          {
            date: "2026-05-10",
            totalTokens: 20,
            segments: [
              {
                providerId: "local-ollama",
                model: "llama3",
                totalTokens: 20,
              },
            ],
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

function observabilityWindows(client: SearchClient): number[] {
  return vi
    .mocked(client.observability)
    .mock.calls.map(([input]) => input.recentDays);
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
      expect(screen.getByLabelText("Recent indexed nodes bar chart")).toBeInTheDocument();
      expect(screen.getByLabelText("P99 latency line chart")).toBeInTheDocument();
      expect(screen.getByLabelText("Token usage daily stacked bar chart")).toBeInTheDocument();
    });
    expect(screen.getByText("llama3 · local-ollama")).toBeInTheDocument();
    expect(screen.queryByText("Downloads")).not.toBeInTheDocument();
    expect(client.observability).toHaveBeenCalledWith({ recentDays: 30 });
    expect(observabilityWindows(client)).toEqual([30]);
    expect(client.settings).not.toHaveBeenCalled();
  });

  it("reloads only recent indexing when the range changes", async () => {
    const client = makeClient();
    render(<HomeDashboard client={client} />);

    await waitFor(() => {
      expect(client.observability).toHaveBeenCalledWith({ recentDays: 30 });
    });

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => {
      expect(client.observability).toHaveBeenCalledWith({ recentDays: 7 });
    });
    await waitFor(() => {
      expect(observabilityWindows(client)).toEqual([30, 7, 30]);
    });
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "90d" }));

    await waitFor(() => {
      expect(client.observability).toHaveBeenCalledWith({ recentDays: 90 });
    });
    await waitFor(() => {
      expect(observabilityWindows(client)).toEqual([30, 7, 30, 90, 30]);
    });
    expect(screen.getByRole("button", { name: "90d" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("switches the latency chart percentile", async () => {
    const client = makeClient();
    render(<HomeDashboard client={client} />);

    expect(await screen.findByLabelText("P99 latency line chart")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "P50" }));

    expect(screen.getByRole("button", { name: "P50" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByLabelText("P50 latency line chart")).toBeInTheDocument();
  });

  it("filters the latency chart by category from the legend", async () => {
    const client = makeClient();
    render(<HomeDashboard client={client} />);

    expect(await screen.findByLabelText("P99 latency line chart")).toBeInTheDocument();
    const searchFilter = screen.getByRole("button", { name: /Search 20 ms/ });
    const indexFilter = screen.getByRole("button", { name: /Index 44 ms/ });

    expect(searchFilter).toHaveAttribute("aria-pressed", "false");
    expect(indexFilter).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(indexFilter);

    expect(indexFilter).toHaveAttribute("aria-pressed", "true");
    expect(searchFilter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("P99 latency line chart")).toBeInTheDocument();

    fireEvent.click(indexFilter);

    expect(indexFilter).toHaveAttribute("aria-pressed", "false");
  });
});
