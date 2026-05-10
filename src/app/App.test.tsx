import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const getExplorerSnapshot = vi.fn();
const getMountSetupContext = vi.fn();
const createFolder = vi.fn();
const createMount = vi.fn();
const createUrl = vi.fn();
const readFileContent = vi.fn().mockResolvedValue("");
const openExternal = vi.fn().mockResolvedValue(undefined);
const showNodeInFileManager = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/tauri/ipc", () => ({
  getExplorerSnapshot: () => getExplorerSnapshot(),
  getMountSetupContext: () => getMountSetupContext(),
  getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
  createFolder: (input: unknown) => createFolder(input),
  createMount: (input: unknown) => createMount(input),
  createNote: vi.fn(),
  createUrl: (input: unknown) => createUrl(input),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
    reindexNode: vi.fn().mockResolvedValue({ enqueued: 0 }),
  retryUrl: vi.fn(),
  getNoteContent: vi.fn().mockResolvedValue(""),
  saveNoteContent: vi.fn(),
  readFileContent: (nodeId: string) => readFileContent(nodeId),
  showNodeInFileManager: (nodeId: string) => showNodeInFileManager(nodeId),
  showNodeExtractArtifacts: vi.fn().mockResolvedValue(undefined),
  // Phase 2 / Unit 7 search-sidecar bridge — stubbed for the App test.
  searchQuery: vi.fn().mockResolvedValue({ state: "initialising" }),
  getIndexingStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
  getNodeIndexingStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
  getModelsStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
  startModelDownload: vi.fn().mockResolvedValue(undefined),
  getNodeContent: vi.fn().mockResolvedValue({ state: "initialising" }),
  // Feature-oriented Settings (Phase 1) bridge — stubbed.
  getSearchSettings: vi.fn().mockResolvedValue({ state: "initialising" }),
  updateSearchSettings: vi.fn().mockResolvedValue({ state: "initialising" }),
  readSearchSettingsFallback: vi.fn().mockResolvedValue({
    version: 1,
    providers: {},
    features: {},
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  }),
  restartSidecar: vi.fn().mockResolvedValue(undefined),
  setProviderSecret: vi.fn().mockResolvedValue(undefined),
  getProviderSecretPresent: vi.fn().mockResolvedValue(false),
  deleteProviderSecret: vi.fn().mockResolvedValue(undefined),
  createChatSession: vi.fn().mockResolvedValue({
    id: "s1",
    title: "Research chat",
    boundNoteId: null,
    createdAt: "now",
    updatedAt: "now",
  }),
  listChatSessions: vi.fn().mockResolvedValue([]),
  getChatSession: vi.fn().mockResolvedValue({
    session: {
      id: "s1",
      title: "Research chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    },
    messages: [],
    clusters: [],
  }),
  deleteChatSession: vi.fn().mockResolvedValue({ deleted: true }),
  getChatSessionMemory: vi.fn().mockResolvedValue({ available: false }),
  exportChatSessionMemory: vi.fn().mockResolvedValue({
    noteId: "note-1",
    snapshot: { roots: [] },
  }),
  triggerChatSessionMemoryOpportunity: vi.fn().mockResolvedValue(undefined),
  updateChatSessionTitle: vi.fn().mockImplementation(async (input: { sessionId: string; title: string }) => ({
    id: input.sessionId,
    title: input.title,
    boundNoteId: null,
    createdAt: "now",
    updatedAt: "now",
  })),
  appendChatMessage: vi.fn(),
  recordChatCluster: vi.fn(),
  bindChatNote: vi.fn(),
  startChatTurn: vi.fn().mockResolvedValue({ turn: { state: "initialising" } }),
  getChatModels: vi.fn().mockResolvedValue({ models: { state: "initialising" } }),
  testChatProvider: vi.fn().mockResolvedValue({
    result: { state: "initialising" },
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    close: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (target: string) => openExternal(target),
}));

function clickTreeRow(name: string) {
  const buttons = screen.getAllByRole("button");
  const target = buttons.find(
    (btn) => btn.classList.contains("tree-row-main") && btn.textContent?.includes(name)
  );
  if (!target) {
    throw new Error(`tree row not found for: ${name}`);
  }
  fireEvent.click(target);
}

describe("App", () => {
  beforeEach(() => {
    getExplorerSnapshot.mockReset();
    getMountSetupContext.mockReset();
    getMountSetupContext.mockResolvedValue({ suggestedFolders: [], existingMounts: [] });
    createFolder.mockReset();
    createMount.mockReset();
    createUrl.mockReset();
    readFileContent.mockReset();
    readFileContent.mockResolvedValue("");
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    showNodeInFileManager.mockReset();
    showNodeInFileManager.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the welcome state with empty backend snapshot", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });

    render(<App />);

    expect(screen.getByRole("button", { name: /Explorer/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByText(/select an item to preview/i)).toBeInTheDocument();
    // Inspector empty placeholder
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("submits a new folder via the tree toolbar and renders it in the tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createFolder.mockResolvedValue({
      roots: [
        {
          id: "folder-1",
          parentId: null,
          name: "Untitled",
          kind: "folder",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });

    render(<App />);

    await screen.findByText(/select an item to preview/i);
    fireEvent.click(screen.getByRole("menuitem", { name: /New Folder/i }));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith({
        name: "Untitled",
        parentId: undefined,
      });
    });

    // New folder lands in inline-rename mode (input with the placeholder name)
    expect(await screen.findByDisplayValue("Untitled")).toBeInTheDocument();
  });

  it("submits a mount path and renders the mounted tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createMount.mockResolvedValue({
      roots: [
        {
          id: "mount-1",
          parentId: null,
          name: "workspace",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 4,
          children: [
            {
              id: "file-1",
              parentId: "mount-1",
              name: "notes.txt",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-13 00:00:00",
              modifiedAt: "2026-04-13 00:00:00",
              sizeBytes: 4,
              children: [],
            },
          ],
        },
      ],
    });

    render(<App />);

    await screen.findByText(/select an item to preview/i);
    fireEvent.click(screen.getByRole("menuitem", { name: /Mount Folder/i }));

    fireEvent.change(screen.getByPlaceholderText(/~\/projects\/example/i), {
      target: { value: "~/workspace" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Mount$/i }));

    await waitFor(() => {
      expect(createMount).toHaveBeenCalledWith(
        expect.objectContaining({ path: "~/workspace", parentId: undefined })
      );
    });

    // Mount auto-expands as a root, so the child file is visible in the tree
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
  });

  it("submits a url and renders the pending node in the tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createUrl.mockResolvedValue({
      roots: [
        {
          id: "url-1",
          parentId: null,
          name: "https://example.com",
          kind: "url",
          state: "pending",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });

    render(<App />);

    await screen.findByText(/select an item to preview/i);
    fireEvent.click(screen.getByRole("menuitem", { name: /Add URL/i }));

    fireEvent.change(screen.getByPlaceholderText(/https:\/\/example.com/i), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Fetch & Create/i }));

    await waitFor(() => {
      expect(createUrl).toHaveBeenCalledWith({
        url: "https://example.com",
        parentId: undefined,
      });
    });

    expect(await screen.findByText("https://example.com")).toBeInTheDocument();
  });

  it("opens markdown preview when clicking a .md file row", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "mount-1",
          parentId: null,
          name: "workspace",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-26 00:00:00",
          modifiedAt: "2026-04-26 00:00:00",
          sizeBytes: 0,
          children: [
            {
              id: "md-file",
              parentId: "mount-1",
              name: "README.md",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-26 00:00:00",
              modifiedAt: "2026-04-26 00:00:00",
              sizeBytes: 32,
              children: [],
            },
          ],
        },
      ],
    });
    readFileContent.mockResolvedValue("# Welcome to the workspace");

    render(<App />);

    // Mount auto-expands; file row is visible immediately
    await screen.findByText("README.md");
    clickTreeRow("README.md");

    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledWith("md-file");
    });
    expect(await screen.findByText("Read-only preview")).toBeInTheDocument();
  });

  it("does not open the browser on a URL row click — open is via the right-click 'Open link' menu", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "url-1",
          parentId: null,
          name: "https://example.com",
          kind: "url",
          state: "indexed",
          createdAt: "2026-04-26 00:00:00",
          modifiedAt: "2026-04-26 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });

    render(<App />);

    const urlText = await screen.findByText("https://example.com");
    clickTreeRow("https://example.com");

    // Single-click selects but does NOT open the browser
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.getByText(/select an item to preview/i)).toBeInTheDocument();

    // Right-click → "Open link" opens the browser
    fireEvent.contextMenu(urlText);
    fireEvent.click(screen.getByRole("button", { name: /^open link$/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith("https://example.com");
    });
  });

  it("shows 'cannot preview' placeholder for unsupported file kinds", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "mount-1",
          parentId: null,
          name: "workspace",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-26 00:00:00",
          modifiedAt: "2026-04-26 00:00:00",
          sizeBytes: 0,
          children: [
            {
              id: "bin-file",
              parentId: "mount-1",
              name: "data.bin",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-26 00:00:00",
              modifiedAt: "2026-04-26 00:00:00",
              sizeBytes: 1024,
              children: [],
            },
          ],
        },
      ],
    });

    render(<App />);

    await screen.findByText("data.bin");
    clickTreeRow("data.bin");

    expect(await screen.findByText(/this file type cannot be previewed/i)).toBeInTheDocument();
    // Inspector reflects the selected file (tree row + inspector header both contain the name)
    expect(screen.getAllByText("data.bin").length).toBeGreaterThan(0);
  });

  it("toggles folder expansion when the row is clicked, no center change", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "mount-1",
          parentId: null,
          name: "workspace",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-26 00:00:00",
          modifiedAt: "2026-04-26 00:00:00",
          sizeBytes: 0,
          children: [
            {
              id: "folder-1",
              parentId: "mount-1",
              name: "docs",
              kind: "folder",
              state: "ready",
              createdAt: "2026-04-26 00:00:00",
              modifiedAt: "2026-04-26 00:00:00",
              sizeBytes: 0,
              children: [
                {
                  id: "child",
                  parentId: "folder-1",
                  name: "guide.md",
                  kind: "file",
                  state: "ready",
                  createdAt: "2026-04-26 00:00:00",
                  modifiedAt: "2026-04-26 00:00:00",
                  sizeBytes: 8,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });

    render(<App />);

    await screen.findByText("docs");
    // child is hidden until folder is expanded
    expect(screen.queryByText("guide.md")).toBeNull();
    clickTreeRow("docs");
    expect(await screen.findByText("guide.md")).toBeInTheDocument();
    // welcome stays
    expect(screen.getByText(/select an item to preview/i)).toBeInTheDocument();
  });

  it("keeps explorer state when switching to another shell section and back", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "folder-1",
          parentId: null,
          name: "Inbox",
          kind: "folder",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Home$/i }));
    expect(screen.getByText(/This section is stubbed in Milestone 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(getExplorerSnapshot).toHaveBeenCalledTimes(1);
  });
});
