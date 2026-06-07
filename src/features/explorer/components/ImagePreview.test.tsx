import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
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

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `http://asset.localhost${path}`,
}));

afterEach(() => cleanup());

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn(),
    indexStatus: vi.fn(),
    indexStatistics: vi.fn().mockResolvedValue({ recentIndexedNodes: [] }),
    observability: vi.fn(),
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
    testChatProvider: vi.fn().mockResolvedValue({
      result: { state: "initialising" },
    }),
    ...overrides,
  };
}

function clientWithChunks(
  chunks: NodeContentChunk[],
  assets: Record<string, string> = {}
): SearchClient {
  return makeClient({
    nodeContent: vi.fn().mockResolvedValue({
      state: "ready",
      data: { nodeId: "img-1", kind: "file", chunks, joined: "", assets },
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

  it("renders PDF extracted markdown as a body section", async () => {
    const client = clientWithChunks([
      {
        id: "pdf-1:0",
        role: "body",
        text: "| item | total |\n| --- | --- |\n| CT | 144 |",
      },
    ]);
    const { container } = render(
      <ImagePreview
        contentKind="pdf"
        searchClient={client}
        nodeId="pdf-1"
        name="scan.pdf"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/^Extracted Text$/)).toBeInTheDocument();
      expect(container.querySelector("table")).toBeInTheDocument();
    });
    expect(screen.queryByText(/^OCR$/)).not.toBeInTheDocument();
  });

  it("renders URL markdown as a page section", async () => {
    const client = clientWithChunks([
      {
        id: "url-1:0",
        role: "body",
        text: "# Example Page\n\nRead the [docs](https://example.test/docs).",
      },
    ]);
    const { container } = render(
      <ImagePreview
        contentKind="url"
        searchClient={client}
        nodeId="url-1"
        name="https://example.test"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/^Page$/)).toBeInTheDocument();
      expect(
        container.querySelector("a[href='https://example.test/docs']")
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/^OCR$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Extracted Text$/)).not.toBeInTheDocument();
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

  it("renders OCR markdown with inline HTML and GFM tables", async () => {
    const client = clientWithChunks([
      {
        id: "img-1:0",
        role: "body",
        text: '<div align="center"><img src="https://example.com/invoice.png" alt="invoice" /></div>\n\n| item | total |\n| --- | --- |\n| CT | 144 |',
      },
    ]);
    const { container } = render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );

    await waitFor(() => {
      expect(container.querySelector("img[alt='invoice']")).toBeInTheDocument();
      expect(container.querySelector("table")).toBeInTheDocument();
    });
  });

  it("toggles OCR markdown from rendered preview to raw source", async () => {
    const client = clientWithChunks([
      {
        id: "img-1:0",
        role: "body",
        text: '<div align="center"><img src="https://example.com/invoice.png" alt="invoice" /></div>',
      },
    ]);
    const { container } = render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );

    await waitFor(() => {
      expect(container.querySelector("img[alt='invoice']")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: /^source$/i }));

    await waitFor(() => {
      expect(container.querySelector("img[alt='invoice']")).toBeNull();
      expect(container.querySelector(".cm-content")?.textContent).toContain(
        '<div align="center">'
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: /^preview$/i }));

    await waitFor(() => {
      expect(container.querySelector("img[alt='invoice']")).toBeInTheDocument();
    });
  });

  it("rewrites cached OCR asset references in preview only", async () => {
    const client = clientWithChunks(
      [
        {
          id: "img-1:0",
          role: "body",
          text: '<img src="imgs/crop.png" alt="crop" />',
        },
      ],
      { "imgs/crop.png": "/tmp/crop.png" }
    );
    const { container } = render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );

    await waitFor(() => {
      expect(container.querySelector("img[alt='crop']")?.getAttribute("src")).toBe(
        "http://asset.localhost/tmp/crop.png"
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: /^source$/i }));

    await waitFor(() => {
      expect(container.querySelector(".cm-content")?.textContent).toContain(
        'src="imgs/crop.png"'
      );
    });
  });

  it("rewrites advanced OCR jpg references to extracted png assets", async () => {
    const source = "imgs/img_in_chart_box_50_39_1204_423.jpg";
    const assetPath =
      "/Users/test/.cogios/extract/1bf3e220-234d-4e0f-a59d-0595e2d17f2e/assets/advanced/imgs/img_in_chart_box_50_39_1204_423.png";
    const client = clientWithChunks(
      [
        {
          id: "pdf-1:0",
          role: "body",
          text: `<div style="text-align: center;"><img src="${source}" alt="Image" width="94%" /></div>`,
        },
      ],
      { [source]: assetPath }
    );
    const { container } = render(
      <ImagePreview
        contentKind="pdf"
        searchClient={client}
        nodeId="pdf-1"
        name="advanced.pdf"
      />
    );

    await waitFor(() => {
      expect(
        container.querySelector("img[alt='Image']")?.getAttribute("src")
      ).toBe(`http://asset.localhost${assetPath}`);
    });

    fireEvent.click(screen.getByRole("tab", { name: /^source$/i }));

    await waitFor(() => {
      expect(container.querySelector(".cm-content")?.textContent).toContain(
        `src="${source}"`
      );
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

  it("renders the PDF empty state when no extracted text is available", async () => {
    const client = clientWithChunks([]);
    render(
      <ImagePreview
        contentKind="pdf"
        searchClient={client}
        nodeId="pdf-1"
        name="scan.pdf"
      />
    );
    await waitFor(() => {
      expect(
        screen.getByText(/this PDF hasn't produced extracted text yet/i)
      ).toBeInTheDocument();
    });
  });

  it("renders the URL empty state when no markdown is available", async () => {
    const client = clientWithChunks([]);
    render(
      <ImagePreview
        contentKind="url"
        searchClient={client}
        nodeId="url-1"
        name="https://example.test"
      />
    );
    await waitFor(() => {
      expect(
        screen.getByText(/this URL hasn't produced a readable page preview yet/i)
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
