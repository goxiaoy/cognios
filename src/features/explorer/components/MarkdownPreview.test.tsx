import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";
import type { ExplorerClient } from "../types/explorer";

function makeClient(overrides: Partial<ExplorerClient> = {}): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn(),
    getMountSetupContext: vi.fn(),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    reindexNode: vi.fn().mockResolvedValue({ enqueued: 0 }),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn().mockResolvedValue(""),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
    ...overrides,
  };
}

describe("MarkdownPreview", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
  });

  it("loads file content and renders it as HTML in the default preview mode", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockResolvedValue("# Hello world\n\nA paragraph."),
    });

    render(
      <MarkdownPreview
        client={client}
        name="README.md"
        nodeId="node-1"
      />
    );

    expect(client.readFileContent).toHaveBeenCalledWith("node-1");

    // In preview mode the H1 is rendered as a real heading element, not as raw "# Hello world"
    expect(
      await screen.findByRole("heading", { level: 1, name: "Hello world" })
    ).toBeInTheDocument();
    expect(screen.getByText("A paragraph.")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Read-only preview")).toBeInTheDocument();
  });

  it("toggles to source mode and shows raw markdown in CodeMirror", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockResolvedValue("# Hello world"),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="README.md"
        nodeId="node-1"
      />
    );

    // Wait for content to load (default preview mode)
    await screen.findByRole("heading", { level: 1, name: "Hello world" });

    // Switch to source mode
    fireEvent.click(screen.getByRole("tab", { name: /^source$/i }));

    await waitFor(() => {
      const cm = container.querySelector(".cm-content");
      expect(cm?.textContent).toContain("# Hello world");
    });
    // Heading is gone (no longer rendered)
    expect(screen.queryByRole("heading", { level: 1, name: "Hello world" })).toBeNull();
  });

  it("renders inline HTML in preview mode (rehype-raw)", async () => {
    const client = makeClient({
      readFileContent: vi
        .fn()
        .mockResolvedValue('<div align="center"><img src="https://example.com/logo.png" alt="logo" /></div>'),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="README.md"
        nodeId="node-1"
      />
    );

    await waitFor(() => {
      const img = container.querySelector("img[alt='logo']");
      expect(img).toBeInTheDocument();
    });
  });

  it("renders GFM tables (remark-gfm)", async () => {
    const client = makeClient({
      readFileContent: vi
        .fn()
        .mockResolvedValue("| col1 | col2 |\n| --- | --- |\n| a | b |"),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="t.md"
        nodeId="n"
      />
    );

    await waitFor(() => {
      expect(container.querySelector("table")).toBeInTheDocument();
    });
  });

  it("renders inline and block math formulas", async () => {
    const client = makeClient({
      readFileContent: vi
        .fn()
        .mockResolvedValue(
          "Inline $E = mc^2$.\n\n$$\n\\int_0^1 x^2 dx\n$$"
        ),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="math.md"
        nodeId="n"
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".katex")).toBeInTheDocument();
      expect(container.querySelector(".katex-display")).toBeInTheDocument();
    });
  });

  it("shows file-too-large error for that error category", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new Error("file too large")),
    });

    render(
      <MarkdownPreview
        client={client}
        name="big.md"
        nodeId="n"
      />
    );

    expect(
      await screen.findByText(/too large to preview/i)
    ).toBeInTheDocument();
  });

  it("shows generic error for file-unavailable", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new Error("file unavailable")),
    });

    render(
      <MarkdownPreview
        client={client}
        name="missing.md"
        nodeId="n"
      />
    );

    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
  });

  it("shows not-previewable error for that category", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new Error("not previewable")),
    });

    render(
      <MarkdownPreview
        client={client}
        name="x.bin"
        nodeId="n"
      />
    );

    expect(
      await screen.findByText(/cannot be previewed/i)
    ).toBeInTheDocument();
  });

  it("renders the title while showing an error (no white screen)", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new Error("file unavailable")),
    });

    render(
      <MarkdownPreview
        client={client}
        name="x.md"
        nodeId="n"
      />
    );

    await screen.findByText(/not available/i);
    expect(screen.getByText("x.md")).toBeInTheDocument();
  });

  it("renders empty file content without crashing", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockResolvedValue(""),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="empty.md"
        nodeId="n"
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".markdown-preview-rendered")).toBeInTheDocument();
    });
  });

  it("does not setState after unmount when load resolves late", async () => {
    let resolveContent: (value: string) => void = () => {};
    const client = makeClient({
      readFileContent: vi.fn().mockReturnValue(
        new Promise<string>((resolve) => {
          resolveContent = resolve;
        })
      ),
    });

    const { unmount } = render(
      <MarkdownPreview
        client={client}
        name="x.md"
        nodeId="n"
      />
    );

    unmount();
    // Resolve after unmount; the cancelled flag must prevent setState warnings.
    resolveContent("late content");
    // Wait a tick so the microtask runs.
    await new Promise((r) => setTimeout(r, 0));
    // No assertion needed beyond "no warning thrown" — Vitest fails if React logs one.
  });
});
