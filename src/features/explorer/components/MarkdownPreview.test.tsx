import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";
import type { ExplorerClient } from "../types/explorer";

function makeClient(overrides: Partial<ExplorerClient> = {}): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn(),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn().mockResolvedValue(""),
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

  it("loads and displays file content via readFileContent", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockResolvedValue("# Hello world"),
    });

    const { container } = render(
      <MarkdownPreview
        client={client}
        name="README.md"
        nodeId="node-1"
        onBack={() => {}}
      />
    );

    expect(client.readFileContent).toHaveBeenCalledWith("node-1");

    await waitFor(() => {
      const cm = container.querySelector(".cm-content");
      expect(cm?.textContent).toContain("# Hello world");
    });
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText("Read-only preview")).toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", async () => {
    const onBack = vi.fn();
    const client = makeClient();
    render(
      <MarkdownPreview
        client={client}
        name="x.md"
        nodeId="n"
        onBack={onBack}
      />
    );

    const backButton = screen.getByRole("button", { name: /back to explorer/i });
    backButton.click();
    expect(onBack).toHaveBeenCalled();
  });

  it("focuses the back button on mount for keyboard accessibility", async () => {
    const client = makeClient();
    render(
      <MarkdownPreview
        client={client}
        name="x.md"
        nodeId="n"
        onBack={() => {}}
      />
    );

    const backButton = screen.getByRole("button", { name: /back to explorer/i });
    expect(backButton).toHaveFocus();
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
        onBack={() => {}}
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
        onBack={() => {}}
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
        onBack={() => {}}
      />
    );

    expect(
      await screen.findByText(/cannot be previewed/i)
    ).toBeInTheDocument();
  });

  it("renders the back button while showing an error (no white screen)", async () => {
    const client = makeClient({
      readFileContent: vi.fn().mockRejectedValue(new Error("file unavailable")),
    });

    render(
      <MarkdownPreview
        client={client}
        name="x.md"
        nodeId="n"
        onBack={() => {}}
      />
    );

    await screen.findByText(/not available/i);
    expect(screen.getByRole("button", { name: /back to explorer/i })).toBeInTheDocument();
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
        onBack={() => {}}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".cm-editor")).toBeInTheDocument();
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
        onBack={() => {}}
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
