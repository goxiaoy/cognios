import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";

import { SettingsLayout } from "./SettingsLayout";
import type { SearchSettings } from "../../../lib/contracts/search";
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
      data: {
        queueDepth: 2,
        inFlight: ["x"],
        enhancementInFlight: [],
        indexedChunks: 50,
        enhancementPending: 0,
        enhancementFailed: 0,
        enhancementTotalImages: 0,
      },
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
          },
        },
      },
    }),
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

function readySettings(): { state: "ready"; data: SearchSettings } {
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

  it("renders the diagnostics summary and exposes model state inline (no toggle)", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(screen.getByText("Features")).toBeInTheDocument();
    });
    // The bottom strip is always-visible — no "Show Diagnostics"
    // toggle exists anymore.
    expect(
      screen.queryByRole("button", { name: /show diagnostics/i })
    ).toBeNull();
    expect(screen.getByText("Indexed items")).toBeInTheDocument();
    // The local-gte provider's role is "ready" in the makeClient
    // mock, so its row's status pill reads "Ready".
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("labels ready cloud provider actions as Details instead of Edit", async () => {
    const ready = readySettings();
    ready.data.providers.openai = {
      providerId: "openai",
      enabled: true,
      apiKeyRef: "keychain://cognios-search/provider:openai",
      baseUrl: "https://api.openai.com/v1",
      modelPerCapability: {},
    };
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(ready),
      hasProviderSecret: vi.fn().mockImplementation(({ providerId }) =>
        Promise.resolve(providerId === "openai")
      ),
    });
    render(<SettingsLayout client={client} />);

    const openaiName = await screen.findByText("OpenAI");
    const openaiRow = openaiName.closest("li");
    expect(openaiRow).not.toBeNull();
    expect(
      within(openaiRow as HTMLElement).getByRole("button", { name: /Details/i })
    ).toBeInTheDocument();
    expect(
      within(openaiRow as HTMLElement).queryByRole("button", { name: /Edit/i })
    ).toBeNull();
  });

  it("opens basic configuration fields for the Ollama provider", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);

    const ollamaName = await screen.findByText("Ollama");
    const ollamaRow = ollamaName.closest("li");
    expect(ollamaRow).not.toBeNull();
    fireEvent.click(
      within(ollamaRow as HTMLElement).getByRole("button", { name: /Details/i })
    );

    expect(await screen.findByLabelText(/base url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/chat model/i)).toBeInTheDocument();
  });

  it("renders OCR enhancement diagnostics when advanced OCR is ready", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
      indexStatus: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          queueDepth: 0,
          inFlight: [],
          enhancementInFlight: [],
          indexedChunks: 20,
          enhancementPending: 4,
          enhancementFailed: 1,
          enhancementTotalImages: 10,
        },
      }),
      modelsStatus: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          roles: {
            "advanced-ocr-detection": {
              role: "advanced-ocr-detection",
              state: "ready",
              repo: "PaddlePaddle/PP-OCRv4_mobile_det",
              commit: "abcdef0123",
            },
          },
        },
      }),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(screen.getByText("OCR enhancement")).toBeInTheDocument();
    });
    expect(screen.getByText("5 / 10")).toBeInTheDocument();
    expect(screen.getByText("4 remaining")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
  });
});
