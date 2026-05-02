import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SettingsLayout } from "./SettingsLayout";
import type { SearchClient } from "../../search/types/search";

// SettingsLayout subscribes to Tauri's models/progress event via
// useModelDownloadProgress; provide a no-op listener in JSDOM.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({ state: "initialising" }),
    indexStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: { queueDepth: 2, inFlight: ["x"], indexedChunks: 50 },
    }),
    nodeIndexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    modelsStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        roles: {
          embedding: {
            role: "embedding",
            state: "ready",
            repo: "onnx-community/gte-multilingual-base",
            commit: "abcdef0123",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        },
      },
    }),
    acceptModelLicense: vi.fn().mockResolvedValue({ state: "initialising" }),
    startModelDownload: vi.fn().mockResolvedValue(undefined),
    nodeContent: vi.fn().mockResolvedValue({ state: "initialising" }),
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

afterEach(() => cleanup());

function readySettings() {
  return {
    state: "ready" as const,
    data: {
      version: 1,
      providers: {
        "local-gte": {
          providerId: "local-gte",
          enabled: true,
          apiKeyRef: null,
          baseUrl: null,
          modelPerCapability: {},
        },
      },
      features: {
        "semantic-search": { enabled: true, providerId: "local-gte" },
        "result-reranking": { enabled: false, providerId: null },
        "image-ocr": { enabled: false, providerId: null },
        "image-captioning": { enabled: false, providerId: null },
      },
      cloudConsentAcked: [] as string[],
      firstRunSkipped: false,
      needsRestart: false,
    },
  };
}

describe("SettingsLayout", () => {
  it("loads settings and renders the Features + Providers sections", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(screen.getByText("Features")).toBeInTheDocument();
    });
    expect(screen.getByText("Providers")).toBeInTheDocument();
    expect(screen.getByText("Semantic search")).toBeInTheDocument();
    expect(client.settings).toHaveBeenCalled();
  });

  it("falls back to direct file read when sidecar is unavailable", async () => {
    const client = makeClient({
      settings: vi
        .fn()
        .mockResolvedValue({ state: "unavailable", error: "no sidecar" }),
      readSettingsFallback: vi
        .fn()
        .mockResolvedValue(readySettings().data),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Sidecar unavailable.*read-only/i)
      ).toBeInTheDocument();
    });
    // Even in fallback mode, the Features list still renders.
    expect(screen.getByText("Semantic search")).toBeInTheDocument();
  });

  it("shows a Restart required banner when needsRestart is true", async () => {
    const ready = readySettings();
    ready.data.needsRestart = true;
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(ready),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Settings changed.*restart/i)
      ).toBeInTheDocument();
    });
  });

  it("reveals legacy Models card when Diagnostics is toggled on", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(screen.getByText("Features")).toBeInTheDocument();
    });
    // ModelManagerStatus's "Models" card title is hidden by default.
    expect(screen.queryByText("Indexed chunks")).toBeNull();

    const toggle = screen.getByRole("button", { name: /show diagnostics/i });
    toggle.click();

    await waitFor(() => {
      expect(screen.getByText("Indexed chunks")).toBeInTheDocument();
    });
  });
});
