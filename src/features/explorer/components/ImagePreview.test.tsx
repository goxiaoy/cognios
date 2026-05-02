import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { SearchClient } from "../../search/types/search";
import { ImagePreview, parseSections } from "./ImagePreview";

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
    acceptModelLicense: vi.fn(),
    startModelDownload: vi.fn(),
    ...overrides,
  };
}

describe("parseSections", () => {
  it("splits OCR + Caption when both are present", () => {
    const sections = parseSections(
      "OCR: Some scanned receipt text\n\nCaption: A whiteboard diagram"
    );
    expect(sections).toEqual([
      { label: "OCR", body: "Some scanned receipt text" },
      { label: "Caption", body: "A whiteboard diagram" },
    ]);
  });

  it("keeps OCR alone when only OCR is present", () => {
    const sections = parseSections("OCR: just text from the image");
    expect(sections).toEqual([
      { label: "OCR", body: "just text from the image" },
    ]);
  });

  it("keeps Caption alone when only Caption is present", () => {
    const sections = parseSections("Caption: A photograph of a window");
    expect(sections).toEqual([
      { label: "Caption", body: "A photograph of a window" },
    ]);
  });

  it("falls back to a single Content section for un-prefixed text", () => {
    const sections = parseSections("Generic indexed body text.");
    expect(sections).toEqual([
      { label: "Content", body: "Generic indexed body text." },
    ]);
  });

  it("returns an empty array for empty / whitespace input", () => {
    expect(parseSections("")).toEqual([]);
    expect(parseSections("   \n  ")).toEqual([]);
  });
});

describe("ImagePreview", () => {
  it("renders a loading state, then the indexed sections from the sidecar", async () => {
    const client = makeClient({
      nodeContent: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          nodeId: "img-1",
          kind: "file",
          chunks: [],
          joined: "OCR: invoice total $42.00\n\nCaption: Photo of a receipt",
        },
      }),
    });
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="receipt.png" />
    );
    expect(screen.getByText(/loading indexed/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/^OCR$/)).toBeInTheDocument();
      expect(screen.getByText(/^Caption$/)).toBeInTheDocument();
    });
    expect(screen.getByText(/invoice total \$42\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Photo of a receipt/)).toBeInTheDocument();
    expect(client.nodeContent).toHaveBeenCalledWith("img-1");
  });

  it("renders the explanatory empty state when no chunks have been indexed", async () => {
    const client = makeClient({
      nodeContent: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          nodeId: "img-1",
          kind: "file",
          chunks: [],
          joined: "",
        },
      }),
    });
    render(
      <ImagePreview searchClient={client} nodeId="img-1" name="x.png" />
    );
    await waitFor(() => {
      expect(
        screen.getByText(/No OCR or caption text indexed yet/i)
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
