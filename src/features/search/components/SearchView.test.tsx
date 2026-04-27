import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExplorerStoreProvider } from "../../explorer/store/ExplorerStoreContext";
import type { ExplorerClient, ExplorerNode } from "../../explorer/types/explorer";
import { SearchView } from "./SearchView";
import type { SearchClient, SearchResult } from "../types/search";

function makeExplorerClient(
  snapshotRoots: ExplorerNode[] = []
): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({ roots: snapshotRoots }),
    getMountSetupContext: vi.fn(),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn().mockResolvedValue("note body"),
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
    ...overrides,
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    nodeId: "11111111-1111-1111-1111-111111111111",
    kind: "note",
    name: "OAuth.md",
    score: 1.2,
    snippet: "PKCE makes refresh safer",
    matchedIn: "content",
    modifiedAt: "2026-04-25T10:00:00Z",
    ...overrides,
  };
}

function renderView(opts: {
  initialQuery?: string;
  searchClient?: SearchClient;
  explorerClient?: ExplorerClient;
  onClose?: () => void;
} = {}) {
  const explorerClient = opts.explorerClient ?? makeExplorerClient();
  return render(
    <ExplorerStoreProvider client={explorerClient}>
      <SearchView
        client={explorerClient}
        searchClient={opts.searchClient ?? makeSearchClient()}
        initialQuery={opts.initialQuery ?? ""}
        onClose={opts.onClose ?? vi.fn()}
      />
    </ExplorerStoreProvider>
  );
}

afterEach(() => cleanup());

describe("SearchView", () => {
  it("seeds the input from initialQuery and triggers a search", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [makeResult()],
        degraded: true,
        partial: null,
        state: "ready",
      },
    });
    renderView({
      initialQuery: "oauth",
      searchClient: makeSearchClient({ search }),
    });

    expect((screen.getByLabelText("Search query") as HTMLInputElement).value).toBe(
      "oauth"
    );
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    expect(search.mock.calls[0][0]).toMatchObject({
      query: "oauth",
      sort: "relevance",
    });
  });

  it("renders results returned by the search client", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [makeResult({ name: "Auth notes.md" })],
        degraded: false,
        partial: null,
        state: "ready",
      },
    });
    renderView({
      initialQuery: "auth",
      searchClient: makeSearchClient({ search }),
    });
    await waitFor(() => {
      expect(screen.getByText("Auth notes.md")).toBeInTheDocument();
    });
  });

  it("Esc on the input invokes onClose", () => {
    const onClose = vi.fn();
    renderView({ onClose });
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("appends a kind filter into the inline-syntax query string sent to the sidecar", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [makeResult()],
        degraded: false,
        partial: null,
        state: "ready",
      },
    });
    renderView({
      initialQuery: "oauth",
      searchClient: makeSearchClient({ search }),
    });
    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    search.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Notes$/ }));

    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
    expect(search.mock.calls[search.mock.calls.length - 1][0]).toMatchObject({
      query: "oauth kind:note",
    });
  });

  it("renders Load more when nextCursor is present and appends results on click", async () => {
    let call = 0;
    const search = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          state: "ready",
          data: {
            results: [makeResult({ nodeId: "a", name: "A.md" })],
            degraded: false,
            partial: null,
            state: "ready",
            nextCursor: "offset:50",
          },
        });
      }
      return Promise.resolve({
        state: "ready",
        data: {
          results: [makeResult({ nodeId: "b", name: "B.md" })],
          degraded: false,
          partial: null,
          state: "ready",
          nextCursor: null,
        },
      });
    });
    renderView({
      initialQuery: "oauth",
      searchClient: makeSearchClient({ search }),
    });

    await waitFor(() => {
      expect(screen.getByText("A.md")).toBeInTheDocument();
    });
    const loadMore = screen.getByRole("button", { name: /^Load more$/ });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText("B.md")).toBeInTheDocument();
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toMatchObject({
      cursor: "offset:50",
    });
    expect(screen.queryByRole("button", { name: /^Load more$/ })).toBeNull();
  });

  it("shows an inline error when the sidecar reports unavailable", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "unavailable",
      error: "sidecar gone",
    });
    renderView({
      initialQuery: "oauth",
      searchClient: makeSearchClient({ search }),
    });
    await waitFor(() => {
      expect(screen.getByText(/sidecar gone/i)).toBeInTheDocument();
    });
  });

  it("emits sort=modified when the dropdown is changed", async () => {
    const search = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [],
        degraded: false,
        partial: null,
        state: "ready",
      },
    });
    renderView({
      initialQuery: "oauth",
      searchClient: makeSearchClient({ search }),
    });
    await waitFor(() => expect(search).toHaveBeenCalled());
    search.mockClear();

    const sortSelect = screen
      .getAllByRole("combobox")
      .find((el) => el.querySelector('option[value="modified"]'));
    expect(sortSelect).toBeDefined();
    fireEvent.change(sortSelect!, { target: { value: "modified" } });

    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(search.mock.calls[search.mock.calls.length - 1][0]).toMatchObject({
      sort: "modified",
    });
  });
});
