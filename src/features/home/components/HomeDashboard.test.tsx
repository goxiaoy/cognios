import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeDashboard } from "./HomeDashboard";
import type {
  IndexStatus,
  ModelsStatus,
  SearchObservability,
  SearchSettings,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { ExplorerNode } from "../../explorer/types/explorer";
import type { SearchClient } from "../../search/types/search";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

afterEach(() => {
  cleanup();
  window.localStorage?.removeItem?.("cognios.homeOnboarding.dismissed.chat-provider");
  window.localStorage?.removeItem?.("cognios.homeOnboarding.dismissed.advanced-ocr");
});

function makeClient(settings = makeSettings()): SearchClient {
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
      data: settings,
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

function makeSettings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    version: 1,
    providers: {
      "local-ollama": {
        providerId: "local-ollama",
        enabled: true,
        baseUrl: "http://127.0.0.1:11434",
        modelPerCapability: {},
      },
      "local-paddleocr-advanced": {
        providerId: "local-paddleocr-advanced",
        enabled: true,
        modelPerCapability: {},
      },
    },
    features: {
      llm: { enabled: true, providerId: "local-ollama" },
      "advanced-ocr": { enabled: false, providerId: null },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
    ...overrides,
  };
}

function node(overrides: Partial<ExplorerNode> = {}): ExplorerNode {
  return {
    id: "node-1",
    parentId: null,
    name: "note.md",
    kind: "note",
    state: "ready",
    createdAt: "2026-05-17 00:00:00",
    modifiedAt: "2026-05-17 00:00:00",
    sizeBytes: 0,
    children: [],
    ...overrides,
  };
}

function makeLoadingClient(): SearchClient {
  return {
    ...makeClient(),
    indexStatus: vi.fn(() => pending<SidecarEnvelope<IndexStatus>>()),
    modelsStatus: vi.fn(() => pending<SidecarEnvelope<ModelsStatus>>()),
    observability: vi.fn(() => pending<SidecarEnvelope<SearchObservability>>()),
  };
}

function pending<T>(): Promise<T> {
  return new Promise(() => {});
}

function observabilityWindows(client: SearchClient): number[] {
  return vi
    .mocked(client.observability)
    .mock.calls.map(([input]) => input.recentDays);
}

describe("HomeDashboard", () => {
  it("renders first-content actions while the workspace is empty", () => {
    const client = makeLoadingClient();
    const onMountFolder = vi.fn();
    const onCreateNote = vi.fn();
    const onStartVoiceNote = vi.fn();

    render(
      <HomeDashboard
        client={client}
        workspaceNodes={[]}
        onMountFolder={onMountFolder}
        onCreateNote={onCreateNote}
        onStartVoiceNote={onStartVoiceNote}
      />
    );

    expect(
      screen.getByRole("heading", { name: /Build your first memory node/i })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Indexed items loading")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Mount Folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create Note/i }));
    fireEvent.click(screen.getByRole("button", { name: /Voice Note/i }));

    expect(onMountFolder).toHaveBeenCalledTimes(1);
    expect(onCreateNote).toHaveBeenCalledTimes(1);
    expect(onStartVoiceNote).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton placeholders while Home data is loading", () => {
    const client = makeLoadingClient();
    render(<HomeDashboard client={client} />);

    expect(screen.getByLabelText("Indexed items loading")).toBeInTheDocument();
    expect(screen.getByLabelText("In flight loading")).toBeInTheDocument();
    expect(screen.getByLabelText("OCR enhancement loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Recent indexing loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Latency loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Token usage loading")).toBeInTheDocument();
  });

  it("keeps Home charts in skeleton state while the sidecar is starting", async () => {
    const client = {
      ...makeClient(),
      indexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
      modelsStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
      observability: vi.fn().mockResolvedValue({ state: "initialising" }),
    };

    render(<HomeDashboard client={client} />);

    expect(await screen.findByLabelText("Indexed items loading")).toBeInTheDocument();
    expect(screen.getByLabelText("In flight loading")).toBeInTheDocument();
    expect(screen.getByLabelText("OCR enhancement loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Recent indexing loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Latency loading")).toBeInTheDocument();
    expect(screen.getByLabelText("Token usage loading")).toBeInTheDocument();
  });

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

  it("shows secondary prompts only after content exists and settings make them relevant", async () => {
    const settings = makeSettings({
      features: {
        llm: { enabled: false, providerId: null },
        "advanced-ocr": { enabled: false, providerId: null },
      },
    });
    const client = makeClient(settings);
    render(
      <HomeDashboard
        client={client}
        workspaceNodes={[node({ id: "scan-1", kind: "file", name: "scan.pdf" })]}
      />
    );

    expect(
      await screen.findByRole("heading", { name: /Configure Chat provider/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Improve OCR for documents/i })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Set up Chat$/i }));
    expect(
      await screen.findByRole("dialog", { name: /^Set up Chat$/i })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));

    fireEvent.click(screen.getByRole("button", { name: /^Set up OCR$/i }));
    expect(
      await screen.findByRole("dialog", { name: /^Set up Advanced OCR$/i })
    ).toBeInTheDocument();
  });

  it("refreshes secondary prompts when settings change outside Home", async () => {
    const disabled = makeSettings({
      features: {
        llm: { enabled: true, providerId: "local-ollama" },
        "advanced-ocr": { enabled: false, providerId: null },
      },
    });
    const enabled = makeSettings({
      features: {
        llm: { enabled: true, providerId: "local-ollama" },
        "advanced-ocr": {
          enabled: true,
          providerId: "local-paddleocr-advanced",
        },
      },
    });
    const client = {
      ...makeClient(disabled),
      settings: vi
        .fn()
        .mockResolvedValueOnce({ state: "ready", data: disabled })
        .mockResolvedValue({ state: "ready", data: enabled }),
    };

    render(
      <HomeDashboard
        client={client}
        workspaceNodes={[node({ id: "scan-1", kind: "file", name: "scan.pdf" })]}
      />
    );

    expect(
      await screen.findByRole("heading", { name: /Improve OCR for documents/i })
    ).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(client.settings).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("heading", { name: /Improve OCR for documents/i })
      ).not.toBeInTheDocument();
    });
  });

  it("places the Chat provider prompt above the status cards", async () => {
    const client = makeClient(
      makeSettings({
        features: {
          llm: { enabled: false, providerId: null },
          "advanced-ocr": { enabled: false, providerId: null },
        },
      })
    );

    render(<HomeDashboard client={client} workspaceNodes={[node()]} />);

    const prompt = await screen.findByRole("heading", {
      name: /Configure Chat provider/i,
    });
    const indexedItems = screen.getByText("Indexed items");

    expect(
      prompt.compareDocumentPosition(indexedItems) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("does not show secondary prompts while settings are unavailable", async () => {
    const client = {
      ...makeClient(),
      settings: vi.fn().mockResolvedValue({ state: "unavailable", error: "down" }),
    };
    render(
      <HomeDashboard
        client={client}
        workspaceNodes={[node({ id: "scan-1", kind: "file", name: "scan.pdf" })]}
      />
    );

    await waitFor(() => {
      expect(client.settings).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Configure Chat provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Improve OCR for documents/i)).not.toBeInTheDocument();
    expect(screen.getByText("Recent indexing")).toBeInTheDocument();
  });

  it("keeps dismissed secondary prompts hidden until their relevance changes", async () => {
    const settings = makeSettings({
      features: {
        llm: { enabled: true, providerId: "local-ollama" },
        "advanced-ocr": { enabled: false, providerId: null },
      },
    });
    const client = makeClient(settings);
    const { rerender } = render(
      <HomeDashboard
        client={client}
        workspaceNodes={[node({ id: "scan-1", kind: "file", name: "scan.pdf" })]}
      />
    );

    expect(
      await screen.findByRole("heading", { name: /Improve OCR for documents/i })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Dismiss Improve OCR for documents/i })
    );
    expect(
      screen.queryByRole("heading", { name: /Improve OCR for documents/i })
    ).not.toBeInTheDocument();

    rerender(
      <HomeDashboard
        client={client}
        workspaceNodes={[node({ id: "scan-2", kind: "file", name: "other.pdf" })]}
      />
    );

    expect(
      await screen.findByRole("heading", { name: /Improve OCR for documents/i })
    ).toBeInTheDocument();
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
