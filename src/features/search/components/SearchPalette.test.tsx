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
    reindexNode: vi.fn().mockResolvedValue({ enqueued: 0 }),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn().mockResolvedValue(""),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn().mockResolvedValue(""),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
  };
}

function makeSearchClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({ state: "initialising" }),
    indexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    nodeIndexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    modelsStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
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
        screen.getByText(/start typing or apply a filter/i)
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

  it("toggles the filter bar via the slider button", () => {
    renderPalette();
    const toggle = screen.getByRole("button", { name: /show filters/i });
    // Initially collapsed: no kind chips visible.
    expect(screen.queryByRole("button", { name: /^Notes$/ })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /^Notes$/ })).toBeInTheDocument();
    // Toggle copy flips after open.
    fireEvent.click(screen.getByRole("button", { name: /hide filters/i }));
    expect(screen.queryByRole("button", { name: /^Notes$/ })).toBeNull();
  });

  it("clicking a kind chip triggers a search with the inline-syntax filter", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [
          {
            nodeId: "abc",
            kind: "note",
            name: "OAuth.md",
            score: 1,
            snippet: "PKCE",
            matchedIn: "content",
          },
        ],
        degraded: false,
        partial: null,
        state: "ready",
      },
    });
    renderPalette({ searchClient: makeSearchClient({ search }) });
    fireEvent.click(screen.getByRole("button", { name: /show filters/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Notes$/ }));
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    const lastCall = search.mock.calls[search.mock.calls.length - 1][0];
    expect(lastCall.query).toBe("kind:note");
  });

  it("renders the Load more button when nextCursor is present and appends results on click", async () => {
    let call = 0;
    const search = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          state: "ready",
          data: {
            results: [
              {
                nodeId: "a",
                kind: "note",
                name: "A.md",
                score: 1,
                snippet: "x",
                matchedIn: "content",
              },
            ],
            degraded: false,
            partial: null,
            state: "ready",
            nextCursor: "offset:25",
          },
        });
      }
      return Promise.resolve({
        state: "ready",
        data: {
          results: [
            {
              nodeId: "b",
              kind: "note",
              name: "B.md",
              score: 0.9,
              snippet: "y",
              matchedIn: "content",
            },
          ],
          degraded: false,
          partial: null,
          state: "ready",
          nextCursor: null,
        },
      });
    });
    renderPalette({ searchClient: makeSearchClient({ search }) });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "x" },
    });
    await waitFor(() => {
      expect(screen.getByText("A.md")).toBeInTheDocument();
    });
    const loadMore = screen.getByRole("button", { name: /^Load more$/ });
    fireEvent.click(loadMore);
    await waitFor(() => {
      expect(screen.getByText("B.md")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /^Load more$/ })
    ).toBeNull();
  });
});
