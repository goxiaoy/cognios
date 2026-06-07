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
        inFlight: ["x"],
        enhancementInFlight: [],
        indexedChunks: 50,
        enhancementPending: 0,
        enhancementFailed: 0,
        enhancementTotalImages: 0,
      },
    }),
    indexStatistics: vi.fn().mockResolvedValue({ recentIndexedNodes: [] }),
    observability: vi.fn().mockResolvedValue({ state: "initialising" }),
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
    testChatProvider: vi.fn().mockResolvedValue({
      result: { state: "initialising" },
    }),
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

  it("keeps diagnostics out of Settings and exposes model state inline", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);
    await waitFor(() => {
      expect(screen.getByText("Features")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /show diagnostics/i })
    ).toBeNull();
    expect(screen.queryByText("Indexed items")).toBeNull();
    // The local-gte provider's role is "ready" in the makeClient
    // mock, so its row's status pill reads "Ready".
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("labels ready cloud provider actions as Details instead of Edit", async () => {
    const ready = readySettings();
    ready.data.providers.openai = {
      providerId: "openai",
      enabled: true,
      apiKeyRef: "env-file://cogios/.env#openai",
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
    await waitFor(() => {
      expect(
        within(openaiRow as HTMLElement).getByRole("button", { name: /Details/i })
      ).toBeInTheDocument();
    });
    expect(
      within(openaiRow as HTMLElement).queryByRole("button", { name: /Edit/i })
    ).toBeNull();
  });

  it("keeps provider filter chips aligned with provider capability labels", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);

    const filterList = await screen.findByRole("tablist", {
      name: /filter providers/i,
    });
    const providersCard = screen.getByText("Providers").closest(".providers-card");
    expect(providersCard).not.toBeNull();
    for (const label of [
      "Embedding",
      "Reranking",
      "Vision",
      "OCR",
      "Advanced OCR",
      "Audio Transcript",
      "LLM",
      "Web Search",
    ]) {
      expect(
        within(filterList).getByRole("tab", {
          name: new RegExp(`^${escapeRegExp(label)}\\d+$`, "i"),
        })
      ).toBeInTheDocument();
    }

    fireEvent.click(within(filterList).getByRole("tab", { name: /LLM/i }));
    expect(within(providersCard as HTMLElement).getByText("Ollama")).toBeInTheDocument();
    expect(within(providersCard as HTMLElement).getByText("OpenAI")).toBeInTheDocument();
    expect(within(providersCard as HTMLElement).queryByText("GTE")).not.toBeInTheDocument();
  });

  it("opens default Ollama configuration from Add", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);

    const ollamaName = await screen.findByText("Ollama");
    const ollamaRow = ollamaName.closest("li");
    expect(ollamaRow).not.toBeNull();
    expect(
      within(ollamaRow as HTMLElement).getByText(/not set up/i)
    ).toBeInTheDocument();
    fireEvent.click(
      within(ollamaRow as HTMLElement).getByRole("button", { name: /Add/i })
    );

    const dialog = await screen.findByRole("dialog", { name: "Ollama" });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Local Ollama" })).toBeNull();
    expect(await screen.findByLabelText(/base url/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/chat model/i)).toBeNull();
  });

  it("marks Ollama ready after its default configuration is saved", async () => {
    const ready = readySettings();
    ready.data.providers["local-ollama"] = {
      providerId: "local-ollama",
      enabled: true,
      apiKeyRef: null,
      baseUrl: "http://127.0.0.1:11434",
      modelPerCapability: {},
    };
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(ready),
    });
    render(<SettingsLayout client={client} />);

    const ollamaName = await screen.findByText("Ollama");
    const ollamaRow = ollamaName.closest("li");
    expect(ollamaRow).not.toBeNull();
    expect(
      within(ollamaRow as HTMLElement).getByRole("button", { name: /Details/i })
    ).toBeInTheDocument();
  });

  it("removes the Local prefix from local model stage details", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
    });
    render(<SettingsLayout client={client} />);

    const gteNames = await screen.findAllByText("GTE");
    const gteRow = gteNames
      .map((node) => node.closest("li.provider-row"))
      .find((node): node is HTMLElement => node !== null);
    if (!gteRow) throw new Error("GTE provider row not found");
    fireEvent.click(
      within(gteRow).getByRole("button", { name: /Details/i })
    );

    expect(await screen.findByRole("dialog", { name: "GTE" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Local GTE" })).toBeNull();
  });

  it("does not render OCR enhancement diagnostics in Settings", async () => {
    const client = makeClient({
      settings: vi.fn().mockResolvedValue(readySettings()),
      indexStatus: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
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
      expect(screen.getByText("Features")).toBeInTheDocument();
    });
    expect(screen.queryByText("OCR enhancement")).toBeNull();
    expect(screen.queryByText("5 / 10")).toBeNull();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
