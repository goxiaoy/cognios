import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerLayout } from "./ExplorerLayout";
import { ExplorerStoreProvider } from "../store/ExplorerStoreContext";
import type { RealtimeVoiceEvent } from "../../../lib/contracts/realtimeVoice";
import type { VoiceNotePreviewSession } from "../../voice-notes/components/VoiceNoteRecordingPreview";

const getVoiceNote = vi.fn();
const getVoiceNoteTranscript = vi.fn();
const appendRealtimeTranscript = vi.fn();
type RealtimeVoiceListener = (event: { payload: RealtimeVoiceEvent }) => void;
const eventMock = vi.hoisted(() => ({
  realtimeVoiceListener: null as RealtimeVoiceListener | null,
}));

function renderWithProvider(
  client: unknown,
  props: Partial<Parameters<typeof ExplorerLayout>[0]> = {}
) {
  const typed = client as Parameters<typeof ExplorerStoreProvider>[0]["client"];
  return render(
    <ExplorerStoreProvider client={typed}>
      <ExplorerLayout active={true} client={typed} {...props} />
    </ExplorerStoreProvider>
  );
}
import type { ExplorerClient, ExplorerNode } from "../types/explorer";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: RealtimeVoiceListener) => {
    if (name === "realtime-voice/event") eventMock.realtimeVoiceListener = cb;
    return () => Promise.resolve();
  }),
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
    appendRealtimeTranscript: (input: unknown) => appendRealtimeTranscript(input),
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
    appendRealtimeTranscript.mockReset();
    appendRealtimeTranscript.mockResolvedValue({
      noteId: "voice-1",
      name: "Live note",
      status: "recording",
      captureStatus: "recording",
      transcriptionStatus: "transcribing",
      summaryStatus: "unavailable",
      sourceAudioPresent: true,
      sourceAudioPath: "/tmp/voice-1.wav",
      sourceAudioDeletedAt: null,
      transcriptPath: "/tmp/voice-1/transcript.md",
      transcriptUpdatedAt: "2026-05-14 00:30:01",
      speakerLabels: {},
      createdAt: "2026-05-14 00:30:00",
      updatedAt: "2026-05-14 00:30:01",
    });
    eventMock.realtimeVoiceListener = null;
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
    expect(await screen.findByText("opening line")).toBeInTheDocument();
    expect(screen.getAllByText("Speaker 1")).toHaveLength(2);
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
      expect(screen.getByText("synced playback line").closest(".voice-note-transcript-sync-line")).toHaveAttribute(
        "aria-current",
        "true"
      );
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("appends finalized realtime voice utterances to the active recording transcript", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [voiceNoteNode("voice-1")],
    });
    const voiceNoteSession = recordingSession("voice-1", 12_345);

    renderWithProvider(client, { voiceNoteSession });

    fireEvent.click(await screen.findByRole("button", { name: /Live note/i }));
    await screen.findByLabelText("Voice note recording");
    expect(eventMock.realtimeVoiceListener).toBeTruthy();

    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "final_utterance",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "  realtime transcript line  ",
        sequence: 1,
        revision: 1,
        startMs: 12_345,
        endMs: 12_345,
      },
    });

    expect(await screen.findByText("realtime transcript line")).toBeInTheDocument();
    expect(appendRealtimeTranscript).toHaveBeenCalledWith({
      noteId: "voice-1",
      transcript: "realtime transcript line",
      startMs: 12_345,
      durationMs: 0,
    });
  });

  it("renders provisional realtime voice captions without appending them to voice notes", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [voiceNoteNode("voice-1")],
    });

    renderWithProvider(client, { voiceNoteSession: recordingSession("voice-1", 5_000) });

    fireEvent.click(await screen.findByRole("button", { name: /Live note/i }));
    await screen.findByLabelText("Voice note recording");
    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "provisional_caption",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "partial text",
        sequence: 1,
        revision: 1,
        startMs: 0,
        endMs: 1_000,
      },
    });

    expect(await screen.findByText("partial text")).toBeInTheDocument();
    expect(appendRealtimeTranscript).not.toHaveBeenCalled();
  });

  it("replaces provisional realtime voice captions by utterance revision", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [voiceNoteNode("voice-1")],
    });

    renderWithProvider(client, { voiceNoteSession: recordingSession("voice-1", 5_000) });

    fireEvent.click(await screen.findByRole("button", { name: /Live note/i }));
    await screen.findByLabelText("Voice note recording");
    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "provisional_caption",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "old partial",
        sequence: 1,
        revision: 1,
        startMs: 0,
        endMs: 1_000,
      },
    });
    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "provisional_caption",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "corrected partial",
        sequence: 2,
        revision: 2,
        startMs: 0,
        endMs: 1_200,
      },
    });
    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "provisional_caption",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "old partial",
        sequence: 3,
        revision: 1,
        startMs: 0,
        endMs: 1_000,
      },
    });

    expect(await screen.findByText("corrected partial")).toBeInTheDocument();
    expect(screen.queryByText("old partial")).not.toBeInTheDocument();
    expect(appendRealtimeTranscript).not.toHaveBeenCalled();
  });

  it("renders persisted native realtime voice utterances without appending them again", async () => {
    const client = makeClient();
    vi.mocked(client.getExplorerSnapshot).mockResolvedValue({
      roots: [voiceNoteNode("voice-1")],
    });

    renderWithProvider(client, { voiceNoteSession: recordingSession("voice-1", 8_000) });

    fireEvent.click(await screen.findByRole("button", { name: /Live note/i }));
    await screen.findByLabelText("Voice note recording");
    eventMock.realtimeVoiceListener?.({
      payload: {
        kind: "final_utterance",
        sessionId: "voice-1",
        utteranceId: "utt-1",
        text: "native realtime line",
        sequence: 2,
        revision: 1,
        startMs: 0,
        endMs: 1_000,
        persisted: true,
      },
    });

    expect(await screen.findByText("native realtime line")).toBeInTheDocument();
    expect(appendRealtimeTranscript).not.toHaveBeenCalled();
  });
});

function treeRowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".node-name")).map(
    (element) => element.textContent ?? ""
  );
}

function voiceNoteNode(id: string): ExplorerNode {
  return {
    id,
    parentId: null,
    name: "Live note",
    kind: "note",
    isVoiceNote: true,
    state: "ready",
    createdAt: "2026-05-14 00:30:00",
    modifiedAt: "2026-05-14 00:30:00",
    sizeBytes: 0,
    children: [],
  };
}

function recordingSession(noteId: string, elapsedMs: number): VoiceNotePreviewSession {
  return {
    note: {
      noteId,
      name: "Live note",
      status: "recording",
      captureStatus: "recording",
      transcriptionStatus: "pending",
      summaryStatus: "unavailable",
      sourceAudioPresent: true,
      sourceAudioPath: "/tmp/voice-1.wav",
      sourceAudioDeletedAt: null,
      transcriptPath: "/tmp/voice-1/transcript.md",
      transcriptUpdatedAt: null,
      speakerLabels: {},
      createdAt: "2026-05-14 00:30:00",
      updatedAt: "2026-05-14 00:30:00",
    },
    elapsedMs,
    phase: "recording",
    error: null,
    onTogglePause: vi.fn(),
    onStop: vi.fn(),
  };
}
