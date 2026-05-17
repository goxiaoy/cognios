import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerLayout } from "./ExplorerLayout";
import { ExplorerStoreProvider } from "../store/ExplorerStoreContext";

const getVoiceNote = vi.fn();
const getVoiceNoteTranscript = vi.fn();

function renderWithProvider(
  client: unknown
) {
  const typed = client as Parameters<typeof ExplorerStoreProvider>[0]["client"];
  return render(
    <ExplorerStoreProvider client={typed}>
      <ExplorerLayout active={true} client={typed} />
    </ExplorerStoreProvider>
  );
}
import type { ExplorerClient } from "../types/explorer";

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
  open: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../voice-notes/api/voiceNoteClient", () => ({
  voiceNoteClient: {
    get: (noteId: string) => getVoiceNote(noteId),
    getTranscript: (noteId: string) => getVoiceNoteTranscript(noteId),
  },
}));

function makeClient(): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({
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
              id: "file-1",
              parentId: "mount-1",
              name: "long-file-name-that-needs-more-room-than-default.md",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-26 00:00:00",
              modifiedAt: "2026-04-26 00:00:00",
              sizeBytes: 2048,
              children: [],
            },
          ],
        },
      ],
    }),
    getMountSetupContext: vi.fn().mockResolvedValue({
      suggestedFolders: [],
      existingMounts: [],
    }),
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
    saveNoteContent: vi.fn().mockResolvedValue(undefined),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
  };
}

describe("ExplorerLayout", () => {
  beforeEach(() => {
    document.body.classList.remove("is-resizing-pane");
    Element.prototype.scrollIntoView = vi.fn();
    getVoiceNote.mockReset();
    getVoiceNote.mockResolvedValue(null);
    getVoiceNoteTranscript.mockReset();
    getVoiceNoteTranscript.mockResolvedValue("");
  });

  afterEach(() => {
    cleanup();
  });

  it("drags the tree separator within clamped bounds", async () => {
    renderWithProvider(makeClient());

    await screen.findByText("long-file-name-that-needs-more-room-than-default.md");

    const workspace = screen.getByTestId("explorer-workspace");
    const separator = screen.getByRole("separator", { name: /resize file tree/i });

    expect(workspace).toHaveStyle({ gridTemplateColumns: "240px 10px minmax(0, 1fr) 280px" });

    fireEvent.mouseDown(separator, { clientX: 240 });
    fireEvent.mouseMove(document, { clientX: 340 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(workspace).toHaveStyle({ gridTemplateColumns: "340px 10px minmax(0, 1fr) 280px" });
    });

    fireEvent.mouseDown(separator, { clientX: 340 });
    fireEvent.mouseMove(document, { clientX: -400 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(workspace).toHaveStyle({ gridTemplateColumns: "208px 10px minmax(0, 1fr) 280px" });
    });
  });

  it("shows a lightweight empty tree state while keeping create controls available", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({ roots: [] });

    renderWithProvider(client);

    expect(
      await screen.findByText(/Mount a folder or create a note/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^New$/i })).toBeInTheDocument();
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("keeps pane scroll containers independent", async () => {
    const { container } = renderWithProvider(makeClient());

    await screen.findByText("long-file-name-that-needs-more-room-than-default.md");

    const treeScroll = container.querySelector(".explorer-tree") as HTMLDivElement;
    const detailScroll = container.querySelector(".detail-surface-scroll") as HTMLDivElement;
    const inspectorScroll = container.querySelector(".inspector-panel-scroll") as HTMLDivElement;

    expect(treeScroll).toBeTruthy();
    expect(detailScroll).toBeTruthy();
    expect(inspectorScroll).toBeTruthy();

    treeScroll.scrollTop = 14;
    inspectorScroll.scrollTop = 21;
    detailScroll.scrollTop = 55;
    fireEvent.scroll(detailScroll);

    expect(treeScroll.scrollTop).toBe(14);
    expect(inspectorScroll.scrollTop).toBe(21);
    expect(detailScroll.scrollTop).toBe(55);
  });

  it("switches file tree sorting with icon controls", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [
        {
          id: "alpha",
          parentId: null,
          name: "Alpha",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-20 00:00:00",
          modifiedAt: "2026-04-22 00:00:00",
          sizeBytes: 0,
          children: [],
        },
        {
          id: "zeta",
          parentId: null,
          name: "Zeta",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-26 00:00:00",
          modifiedAt: "2026-04-21 00:00:00",
          sizeBytes: 0,
          children: [],
        },
      ],
    });
    const { container } = renderWithProvider(client);

    await screen.findByText("Alpha");
    expect(treeRowNames(container)).toEqual(["Zeta", "Alpha"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(treeRowNames(container)).toEqual(["Zeta", "Alpha"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort direction: Z to A" }));
    expect(treeRowNames(container)).toEqual(["Alpha", "Zeta"]);
  });

  it("shows source audio playback when opening an existing voice note", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [
        {
          id: "voice-1",
          parentId: null,
          name: "2026-05-14 00.30.00",
          kind: "note",
          isVoiceNote: true,
          state: "ready",
          createdAt: "2026-05-14 00:30:00",
          modifiedAt: "2026-05-14 00:31:00",
          sizeBytes: 1024,
          children: [],
        },
      ],
    });
    getVoiceNote.mockResolvedValue({
      noteId: "voice-1",
      name: "2026-05-14 00.30.00",
      status: "completed",
      captureStatus: "completed",
      transcriptionStatus: "completed",
      summaryStatus: "ready",
      sourceAudioPresent: true,
      sourceAudioPath: "/tmp/voice-1.wav",
      sourceAudioDeletedAt: null,
      transcriptPath: "/tmp/voice-1/transcript.md",
      transcriptUpdatedAt: "2026-05-14 00:31:00",
      speakerLabels: {},
      createdAt: "2026-05-14 00:30:00",
      updatedAt: "2026-05-14 00:31:00",
    });
    getVoiceNoteTranscript.mockResolvedValue(
      "[00:00.000 - 00:02.000] Speaker 1: opening line\n[00:05.000 - 00:07.500] Speaker 1: synced playback line"
    );

    renderWithProvider(client);

    fireEvent.click(await screen.findByRole("button", {
      name: /2026-05-14 00\.30\.00/i,
    }));

    await waitFor(() => {
      expect(getVoiceNote).toHaveBeenCalledWith("voice-1");
    });
    expect(await screen.findByLabelText("Source audio playback")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Play source audio/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Note title")).toHaveValue("2026-05-14 00.30.00");
    expect(await screen.findByText("Speaker 1: opening line")).toBeInTheDocument();
    expect(screen.getByText("00:00 - 00:02")).toBeInTheDocument();
    expect(screen.getByText("00:05 - 00:07")).toBeInTheDocument();
    expect(document.querySelector(".voice-recording-audio-native")).toHaveAttribute(
      "src",
      "asset:///tmp/voice-1.wav"
    );

    const audio = document.querySelector(".voice-recording-audio-native") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 10 });
    Object.defineProperty(audio, "currentTime", {
      configurable: true,
      writable: true,
      value: 5.1,
    });
    fireEvent.loadedMetadata(audio);
    fireEvent.play(audio);
    fireEvent.timeUpdate(audio);

    await waitFor(() => {
      expect(screen.getByText("Speaker 1: synced playback line").closest(".voice-note-transcript-sync-line")).toHaveAttribute(
        "aria-current",
        "true"
      );
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

function treeRowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".node-name")).map(
    (element) => element.textContent ?? ""
  );
}
