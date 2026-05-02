import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExplorerStoreProvider } from "../../explorer/store/ExplorerStoreContext";
import type { ExplorerClient } from "../../explorer/types/explorer";
import { SearchPalette } from "./SearchPalette";
import type { SearchClient } from "../types/search";

function makeExplorerClient(): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({ roots: [] }),
    getMountSetupContext: vi.fn(),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn().mockResolvedValue(""),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn().mockResolvedValue(""),
    showNodeInFileManager: vi.fn(),
  };
}

function makeSearchClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({ state: "initialising" }),
    indexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    nodeIndexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    modelsStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    acceptModelLicense: vi.fn().mockResolvedValue({ state: "initialising" }),
    startModelDownload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPalette(opts: {
  searchClient?: SearchClient;
  explorerClient?: ExplorerClient;
  onClose?: () => void;
  onActivate?: () => void;
} = {}) {
  return render(
    <ExplorerStoreProvider client={opts.explorerClient ?? makeExplorerClient()}>
      <SearchPalette
        client={opts.searchClient ?? makeSearchClient()}
        onClose={opts.onClose ?? vi.fn()}
        onActivate={opts.onActivate ?? vi.fn()}
      />
    </ExplorerStoreProvider>
  );
}

afterEach(() => cleanup());

describe("SearchPalette", () => {
  it("focuses the input on mount", async () => {
    renderPalette();
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toHaveFocus();
    });
  });

  it("renders the empty-state message when no recent nodes exist", async () => {
    renderPalette();
    await waitFor(() => {
      expect(
        screen.getByText(/start typing to search across notes/i)
      ).toBeInTheDocument();
    });
  });

  // Note: a "renders the recently-modified list" test belongs in the
  // useRecentNodes unit suite — the SearchPalette test wraps the
  // store provider but does not run the App-level snapshot-load
  // effect, so the snapshot stays empty in this harness.

  it("calls Esc to close the palette", () => {
    const onClose = vi.fn();
    renderPalette({ onClose });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the overlay backdrop closes the palette", () => {
    const onClose = vi.fn();
    const { container } = renderPalette({ onClose });
    const overlay = container.querySelector(".search-overlay")!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the dialog inside the overlay does not close", () => {
    const onClose = vi.fn();
    renderPalette({ onClose });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders search results from the client and shows degraded banner", async () => {
    const searchClient = makeSearchClient({
      search: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          results: [
            {
              nodeId: "abc",
              kind: "note",
              name: "OAuth.md",
              score: 1.2,
              snippet: "PKCE",
              matchedIn: "content",
            },
          ],
          degraded: true,
          partial: null,
          state: "ready",
        },
      }),
    });
    renderPalette({ searchClient });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "PKCE" } });

    await waitFor(() => {
      expect(screen.getByText("OAuth.md")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/semantic search initialising/i)
    ).toBeInTheDocument();
  });

  it("Enter activates the highlighted result via the explorer store", async () => {
    const explorerClient = makeExplorerClient();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const searchClient = makeSearchClient({
      search: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          results: [
            {
              nodeId: "abc",
              kind: "note",
              name: "OAuth.md",
              score: 1,
              snippet: "x",
              matchedIn: "content",
            },
          ],
          degraded: true,
          partial: null,
          state: "ready",
        },
      }),
    });

    renderPalette({ searchClient, explorerClient, onClose, onActivate });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "PKCE" } });

    await waitFor(() => {
      expect(screen.getByText("OAuth.md")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable state when the sidecar is unreachable", async () => {
    const searchClient = makeSearchClient({
      search: vi.fn().mockResolvedValue({
        state: "unavailable",
        error: "sidecar gone",
      }),
    });
    renderPalette({ searchClient });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "x" } });

    await waitFor(() => {
      expect(screen.getByText(/sidecar gone/i)).toBeInTheDocument();
    });
  });

  it("ArrowDown / ArrowUp cycle the active row", async () => {
    const searchClient = makeSearchClient({
      search: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          results: [
            { nodeId: "a", kind: "note", name: "A", score: 1, snippet: "a", matchedIn: "content" },
            { nodeId: "b", kind: "note", name: "B", score: 0.9, snippet: "b", matchedIn: "content" },
            { nodeId: "c", kind: "note", name: "C", score: 0.8, snippet: "c", matchedIn: "content" },
          ],
          degraded: true,
          partial: null,
          state: "ready",
        },
      }),
    });
    renderPalette({ searchClient });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "x" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Wrap around: ArrowUp from index 0 → last index.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
