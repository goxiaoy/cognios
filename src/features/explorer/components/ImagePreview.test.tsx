import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { NodeContentChunk } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { ImagePreview } from "./ImagePreview";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

afterEach(() => cleanup());

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn(),
    indexStatus: vi.fn(),
    nodeIndexStatus: vi.fn(),
    nodeContent: vi.fn().mockResolvedValue({
      state: "ready",
      data: { nodeId: "x", kind: "file", chunks: [], joined: "" },
    }),
    modelsStatus: vi.fn(),
    startModelDownload: vi.fn(),
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

function clientWithChunks(chunks: NodeContentChunk[]): SearchClient {
  return makeClient({
    nodeContent: vi.fn().mockResolvedValue({
      state: "ready",
      data: { nodeId: "img-1", kind: "file", chunks, joined: "" },
    }),
  });
}

describe("ImagePreview", () => {
  it("renders OCR (body) and Caption (summary) sections from chunks", async () => {
    const client = clientWithChunks([
      { id: "img-1:0", role: "body", text: "invoice total $42.00" },
      { id: "img-1:1", role: "body", text: "PKCE flow" },
      { id: "img-1:summary:0", role: "summary", text: "Photo of a receipt" },
    ]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="receipt.png" />
    );
    expect(screen.getByText(/loading indexed/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/^OCR$/)).toBeInTheDocument();
      expect(screen.getByText(/^Caption$/)).toBeInTheDocument();
    });
    expect(screen.getByText(/invoice total \$42\.00/)).toBeInTheDocument();
    expect(screen.getByText(/PKCE flow/)).toBeInTheDocument();
    expect(screen.getByText(/Photo of a receipt/)).toBeInTheDocument();
    expect(client.nodeContent).toHaveBeenCalledWith("img-1");
  });

  it("omits Caption when no summary chunks exist", async () => {
    const client = clientWithChunks([
      { id: "img-1:0", role: "body", text: "OCR-only image text" },
    ]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(screen.getByText(/^OCR$/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Caption$/)).not.toBeInTheDocument();
  });

  it("omits OCR when no body chunks exist", async () => {
    const client = clientWithChunks([
      {
        id: "img-1:summary:0",
        role: "summary",
        text: "Caption-only image",
      },
    ]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(screen.getByText(/^Caption$/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/^OCR$/)).not.toBeInTheDocument();
  });

  it("joins multi-chunk summaries in chunk order", async () => {
    const client = clientWithChunks([
      { id: "img-1:summary:0", role: "summary", text: "First half." },
      { id: "img-1:summary:1", role: "summary", text: "Second half." },
    ]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(screen.getByText(/First half\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/Second half\./)).toBeInTheDocument();
  });

  it("renders body text containing the literal substring 'OCR:' verbatim", async () => {
    // Edge case from the plan: a real document with the word
    // "OCR:" in it should render under the OCR header without
    // being double-stripped.
    const client = clientWithChunks([
      {
        id: "img-1:0",
        role: "body",
        text: "OCR: tag literally appears in the text.",
      },
    ]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(
        screen.getByText(/OCR: tag literally appears/)
      ).toBeInTheDocument();
    });
  });

  it("renders the explanatory empty state when no chunks have been indexed", async () => {
    const client = clientWithChunks([]);
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(
        screen.getByText(/hasn'?t been indexed yet/i)
      ).toBeInTheDocument();
    });
  });

  it("surfaces an error when the sidecar reports unavailable", async () => {
    const client = makeClient({
      nodeContent: vi.fn().mockResolvedValue({
        state: "unavailable",
        error: "sidecar gone",
      }),
    });
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(screen.getByText(/sidecar gone/i)).toBeInTheDocument();
    });
  });

  it("renders the file name as the preview title", () => {
    render(
      <ImagePreview
        searchClient={makeClient()}
        nodeId="img-1"
        name="diagram.png"
      />
    );
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
  });
});
