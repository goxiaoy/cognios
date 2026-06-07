import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const getExplorerSnapshot = vi.fn();
const getNodeStatusSnapshot = vi.fn();
const getMountSetupContext = vi.fn();
const createFolder = vi.fn();
const createMount = vi.fn();
const createNote = vi.fn();
const createUrl = vi.fn();
const getNoteContent = vi.fn();
const readFileContent = vi.fn().mockResolvedValue("");
const openExternal = vi.fn().mockResolvedValue(undefined);
const showNodeInFileManager = vi.fn().mockResolvedValue(undefined);
const listChatSessions = vi.fn();
const getChatSession = vi.fn();
const createVoiceNote = vi.fn();
const getVoiceNote = vi.fn();
const getVoiceNoteTranscript = vi.fn();
const beginNativeVoiceNoteAudioCapture = vi.fn();
const finishNativeVoiceNoteAudioCapture = vi.fn();
const pauseNativeVoiceNoteAudioCapture = vi.fn();
const resumeNativeVoiceNoteAudioCapture = vi.fn();
const getModelsStatus = vi.fn();
const startModelDownload = vi.fn();

vi.mock("../lib/tauri/ipc", () => ({
  getExplorerSnapshot: () => getExplorerSnapshot(),
  getNodeStatusSnapshot: () => getNodeStatusSnapshot(),
  getMountSetupContext: () => getMountSetupContext(),
  getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
  createFolder: (input: unknown) => createFolder(input),
  createMount: (input: unknown) => createMount(input),
  createNote: (input: unknown) => createNote(input),
  createUrl: (input: unknown) => createUrl(input),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
    reindexNode: vi.fn().mockResolvedValue({ enqueued: 0 }),
  retryUrl: vi.fn(),
  getNoteContent: (noteId: string) => getNoteContent(noteId),
  saveNoteContent: vi.fn(),
  getVoiceNoteCaptureCapability: vi.fn().mockResolvedValue({
    manualAudioRecording: true,
    systemAudioRecording: false,
    automaticDetection: false,
    reason: "Manual microphone recording is available. Automatic meeting detection and system audio capture are not wired in this build.",
  }),
  createVoiceNote: (input: unknown) => createVoiceNote(input),
  listVoiceNotes: vi.fn().mockResolvedValue([]),
  getVoiceNote: (input: unknown) => getVoiceNote(input),
  getVoiceNoteTranscript: (input: unknown) => getVoiceNoteTranscript(input),
  retranscribeVoiceNote: vi.fn().mockResolvedValue({
    noteId: "voice-note-1",
    nodeId: "note-1",
    status: "pending",
  }),
  completeVoiceNoteTranscript: vi.fn(),
  beginVoiceNoteAudioCapture: vi.fn(),
  appendVoiceNoteAudioChunk: vi.fn(),
  finishVoiceNoteAudioCapture: vi.fn(),
  beginNativeVoiceNoteAudioCapture: (input: unknown) => beginNativeVoiceNoteAudioCapture(input),
  finishNativeVoiceNoteAudioCapture: (input: unknown) => finishNativeVoiceNoteAudioCapture(input),
  pauseNativeVoiceNoteAudioCapture: (input: unknown) => pauseNativeVoiceNoteAudioCapture(input),
  resumeNativeVoiceNoteAudioCapture: (input: unknown) => resumeNativeVoiceNoteAudioCapture(input),
  renameVoiceNoteSpeaker: vi.fn(),
  deleteVoiceNoteSourceAudio: vi.fn(),
  readFileContent: (nodeId: string) => readFileContent(nodeId),
  showNodeInFileManager: (nodeId: string) => showNodeInFileManager(nodeId),
  showNodeExtractArtifacts: vi.fn().mockResolvedValue(undefined),
  // Phase 2 / Unit 7 search-sidecar bridge — stubbed for the App test.
  searchQuery: vi.fn().mockResolvedValue({ state: "initialising" }),
  getIndexingStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
  getIndexStatistics: vi.fn().mockResolvedValue({ recentIndexedNodes: [] }),
  getSearchObservability: vi.fn().mockResolvedValue({
    state: "ready",
    data: {
      recentIndexedNodes: [],
      latency: {
        search: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
        indexing: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
        enhancement: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
        modelDownload: { sampleCount: 0, failureCount: 0, latestMs: null, p50Ms: null, p90Ms: null, p99Ms: null },
      },
      tokenUsage: [],
    },
  }),
  getModelsStatus: () => getModelsStatus(),
  startModelDownload: (input: unknown) => startModelDownload(input),
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
  listChatSessions: () => listChatSessions(),
  getChatSession: (input: unknown) => getChatSession(input),
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

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
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

function makeVoiceNote(overrides: Record<string, unknown> = {}) {
  return {
    noteId: "voice-1",
    name: "2026-05-11 10.00.00",
    status: "pending_audio",
    captureStatus: "unsupported",
    transcriptionStatus: "pending",
    summaryStatus: "unavailable",
    sourceAudioPresent: false,
    sourceAudioPath: null,
    sourceAudioDeletedAt: null,
    transcriptPath: "/tmp/voice-1/transcript.md",
    transcriptUpdatedAt: null,
    speakerLabels: {},
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

function makeVoiceNoteNode() {
  return {
    id: "voice-1",
    parentId: null,
    name: "2026-05-11 10.00.00",
    kind: "note",
    isVoiceNote: true,
    state: "ready",
    createdAt: "now",
    modifiedAt: "now",
    sizeBytes: 0,
    children: [],
  };
}

function readyModels() {
  return {
    state: "ready",
    data: {
      roles: {
        "audio-transcript": {
          role: "audio-transcript",
          state: "ready",
          repo: "Qwen/Qwen3-ASR-0.6B",
        },
      },
    },
  };
}

async function openExplorer() {
  fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
  await screen.findByText(/select an item to preview/i);
}

describe("App", () => {
  beforeEach(() => {
    getExplorerSnapshot.mockReset();
    getNodeStatusSnapshot.mockReset();
    getNodeStatusSnapshot.mockResolvedValue({ revision: 0, nodes: {} });
    getMountSetupContext.mockReset();
    getMountSetupContext.mockResolvedValue({ suggestedFolders: [], existingMounts: [] });
    createFolder.mockReset();
    createMount.mockReset();
    createNote.mockReset();
    createUrl.mockReset();
    getNoteContent.mockReset();
    getNoteContent.mockResolvedValue("");
    readFileContent.mockReset();
    readFileContent.mockResolvedValue("");
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    showNodeInFileManager.mockReset();
    showNodeInFileManager.mockResolvedValue(undefined);
    listChatSessions.mockReset();
    listChatSessions.mockResolvedValue([]);
    getChatSession.mockReset();
    getChatSession.mockResolvedValue({
      session: {
        id: "s1",
        title: "Research chat",
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      },
      messages: [],
      clusters: [],
    });
    createVoiceNote.mockReset();
    createVoiceNote.mockResolvedValue({
      voiceNote: makeVoiceNote(),
      snapshot: { roots: [makeVoiceNoteNode()] },
    });
    getVoiceNote.mockReset();
    getVoiceNote.mockResolvedValue(null);
    getVoiceNoteTranscript.mockReset();
    getVoiceNoteTranscript.mockResolvedValue("");
    beginNativeVoiceNoteAudioCapture.mockReset();
    beginNativeVoiceNoteAudioCapture.mockResolvedValue(
      makeVoiceNote({
        status: "recording",
        captureStatus: "recording",
        sourceAudioPresent: true,
        sourceAudioPath: "/tmp/source.wav",
      })
    );
    finishNativeVoiceNoteAudioCapture.mockReset();
    finishNativeVoiceNoteAudioCapture.mockResolvedValue(
      makeVoiceNote({
        status: "transcribing",
        captureStatus: "completed",
        summaryStatus: "pending",
        sourceAudioPresent: true,
        sourceAudioPath: "/tmp/source.wav",
      })
    );
    pauseNativeVoiceNoteAudioCapture.mockReset();
    pauseNativeVoiceNoteAudioCapture.mockResolvedValue(undefined);
    resumeNativeVoiceNoteAudioCapture.mockReset();
    resumeNativeVoiceNoteAudioCapture.mockResolvedValue(undefined);
    getModelsStatus.mockReset();
    getModelsStatus.mockResolvedValue({ state: "initialising" });
    startModelDownload.mockReset();
    startModelDownload.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("starts on the Home dashboard", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });

    render(<App />);

    expect(screen.getByRole("button", { name: /^Home$/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByRole("heading", {
      name: /Build your first memory node/i,
    })).toBeInTheDocument();
    const actions = within(screen.getByLabelText("First content actions"));
    expect(actions.getByRole("button", { name: /Mount Folder/i })).toBeInTheDocument();
    expect(actions.getByRole("button", { name: /Create Note/i })).toBeInTheDocument();
    expect(actions.getByRole("button", { name: /Voice Note/i })).toBeInTheDocument();
    expect(screen.queryByText("Recent indexing")).not.toBeInTheDocument();
  });

  it("starts the mount flow from the empty Home launchpad", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });

    render(<App />);

    const actions = within(await screen.findByLabelText("First content actions"));
    fireEvent.click(actions.getByRole("button", { name: /Mount Folder/i }));

    expect(screen.getByRole("button", { name: /^Home$/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByRole("dialog", { name: /Mount folder/i })).toBeInTheDocument();
    expect(createMount).not.toHaveBeenCalled();
  });

  it("creates a note from the empty Home launchpad", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createNote.mockResolvedValue({
      roots: [
        {
          id: "note-1",
          parentId: null,
          name: "Untitled",
          kind: "note",
          state: "ready",
          createdAt: "2026-05-17 00:00:00",
          modifiedAt: "2026-05-17 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });

    render(<App />);

    const actions = within(await screen.findByLabelText("First content actions"));
    fireEvent.click(actions.getByRole("button", { name: /Create Note/i }));

    await waitFor(() => {
      expect(createNote).toHaveBeenCalledWith({ parentId: undefined });
    });
    expect(screen.getByRole("button", { name: /^Home$/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByText("Indexed items")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Build your first memory node/i })
    ).not.toBeInTheDocument();
  });

  it("starts a voice note from the empty Home launchpad", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    getModelsStatus.mockResolvedValue(readyModels());

    render(<App />);

    const actions = within(await screen.findByLabelText("First content actions"));
    fireEvent.click(actions.getByRole("button", { name: /Voice Note/i }));

    await waitFor(() => {
      expect(createVoiceNote).toHaveBeenCalledWith({});
    });
    expect(screen.getByRole("button", { name: /^Home$/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByText("Indexed items")).toBeInTheDocument();
  });

  it("renders the Explorer welcome state from the Explorer navigation item", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });

    render(<App />);

    await openExplorer();

    expect(screen.getByRole("button", { name: /Explorer/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("starts a voice note from the sidebar and opens its recording preview in Explorer", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    getModelsStatus.mockResolvedValue(readyModels());
    getVoiceNoteTranscript.mockResolvedValue("[00:00.000] Speaker 1: live transcript");

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Voice Note$/i }));

    await waitFor(() => {
      expect(createVoiceNote).toHaveBeenCalledWith({});
    });
    expect(beginNativeVoiceNoteAudioCapture).toHaveBeenCalledWith({
      noteId: "voice-1",
      mimeType: "audio/wav",
      fileExtension: "wav",
    });
    expect(screen.getByRole("button", { name: /^Explorer$/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByRole("heading", {
      name: "2026-05-11 10.00.00",
    })).toBeInTheDocument();
    expect(screen.getByText("Audio is saved locally on this device.")).toBeInTheDocument();
    expect(await screen.findByText("live transcript")).toBeInTheDocument();
    expect(screen.getByText("00:00.000")).toBeInTheDocument();
    expect(screen.getByText("Speaker 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pause recording/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop recording/i })).toBeInTheDocument();
  });

  it("keeps source audio playback available after stopping a voice note", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    getModelsStatus.mockResolvedValue(readyModels());

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Voice Note$/i }));
    const stopButton = await screen.findByRole("button", { name: /Stop recording/i });
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(finishNativeVoiceNoteAudioCapture).toHaveBeenCalledWith({
        noteId: "voice-1",
        durationMs: expect.any(Number),
      });
    });
    expect(await screen.findByLabelText("Source audio playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Play source audio/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Playback position")).toBeInTheDocument();
    const sourceAudio = document.querySelector(".voice-recording-audio-native");
    expect(sourceAudio).toHaveAttribute("src", "asset:///tmp/source.wav");
    expect(screen.queryByRole("button", { name: /Stop recording/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Note title")).toHaveValue("2026-05-11 10.00.00");
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

    await openExplorer();
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

    await openExplorer();
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

    await openExplorer();
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

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    // Mount auto-expands; file row is visible immediately
    await screen.findByText("README.md");
    clickTreeRow("README.md");

    await waitFor(() => {
      expect(readFileContent).toHaveBeenCalledWith("md-file");
    });
    expect(await screen.findByText("Read-only preview")).toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(breadcrumb).getByText("workspace")).toBeInTheDocument();
    expect(within(breadcrumb).queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "README.md" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    const urlText = await screen.findByText("https://example.com");
    clickTreeRow("https://example.com");

    // Single-click selects but does NOT open the browser
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByText(/select an item to preview/i)).not.toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Home$/i }));
    expect(await screen.findByText("Recent indexing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    expect(await screen.findByText("Inbox")).toBeInTheDocument();
    expect(getExplorerSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the active chat session when switching to Explorer and back", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    const session = {
      id: "chat-1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    listChatSessions.mockResolvedValue([session]);
    getChatSession.mockResolvedValue({
      session,
      messages: [
        {
          id: "m1",
          sessionId: session.id,
          role: "user",
          body: "这次事故的费用是多少？",
          ordinal: 0,
          metadataJson: "{}",
          createdAt: "now",
        },
      ],
      clusters: [],
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Chat$/i }));
    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));
    expect(await screen.findByRole("heading", { name: "事故复盘" })).toBeInTheDocument();
    const callsAfterOpening = listChatSessions.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    expect(screen.getByRole("button", { name: /^Explorer$/i })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: /^Chat$/i }));

    expect(screen.getByRole("heading", { name: "事故复盘" })).toBeInTheDocument();
    expect(listChatSessions).toHaveBeenCalledTimes(callsAfterOpening);
  });
});
