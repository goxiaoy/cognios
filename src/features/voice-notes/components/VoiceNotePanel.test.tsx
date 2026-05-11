import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceNote } from "../../../lib/contracts/voiceNote";
import type { ExplorerClient, ExplorerNode, ExplorerSnapshot } from "../../explorer/types/explorer";
import {
  ExplorerStoreProvider,
  useExplorerStoreContext,
} from "../../explorer/store/ExplorerStoreContext";
import { makeStubSearchClient } from "../../search/types/test-helpers";
import type { VoiceNoteClient } from "../api/voiceNoteClient";
import { VoiceNotePanel } from "./VoiceNotePanel";

function makeModelsStatus(state: string) {
  return {
    state: "ready" as const,
    data: {
      roles: {
        "audio-transcript": {
          role: "audio-transcript",
          state,
          repo: "Qwen/Qwen3-ASR-0.6B",
        },
      },
    },
  };
}

function makeVoiceNote(overrides: Partial<VoiceNote> = {}): VoiceNote {
  return {
    noteId: "voice-1",
    status: "pending_audio",
    captureStatus: "unsupported",
    transcriptionStatus: "pending",
    summaryStatus: "unavailable",
    sourceAudioPresent: false,
    sourceAudioPath: null,
    sourceAudioDeletedAt: null,
    transcriptUpdatedAt: null,
    speakerLabels: {},
    createdAt: "2026-05-11 10:00:00",
    updatedAt: "2026-05-11 10:00:00",
    ...overrides,
  };
}

function makeClient(overrides: Partial<VoiceNoteClient> = {}): VoiceNoteClient {
  return {
    captureCapability: vi.fn().mockResolvedValue({
      systemAudioRecording: false,
      automaticDetection: false,
      reason: "System audio capture and meeting detection are not wired in this build.",
    }),
    create: vi.fn().mockResolvedValue({
      voiceNote: makeVoiceNote({ noteId: "created-1" }),
      snapshot: { roots: [] },
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    completeTranscript: vi.fn(),
    renameSpeaker: vi.fn(),
    deleteSourceAudio: vi.fn(),
    ...overrides,
  };
}

function makeExplorerClient(overrides: Partial<ExplorerClient> = {}): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({ roots: [] }),
    getMountSetupContext: vi.fn().mockResolvedValue({ suggestedFolders: [], existingMounts: [] }),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    reindexNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
    ...overrides,
  };
}

function makeExplorerNote(overrides: Partial<ExplorerNode> = {}): ExplorerNode {
  return {
    id: "created-1",
    parentId: null,
    name: "Untitled",
    kind: "note",
    state: "ready",
    createdAt: "2026-05-11 10:00:00",
    modifiedAt: "2026-05-11 10:00:00",
    sizeBytes: 0,
    children: [],
    ...overrides,
  };
}

function renderWithExplorerStore(
  ui: ReactNode,
  explorerClient: ExplorerClient = makeExplorerClient()
) {
  return render(
    <ExplorerStoreProvider client={explorerClient}>
      {ui}
      <ExplorerSnapshotProbe />
    </ExplorerStoreProvider>
  );
}

function ExplorerSnapshotProbe() {
  const store = useExplorerStoreContext();
  return <span data-testid="explorer-root-count">{store.snapshot.roots.length}</span>;
}

describe("VoiceNotePanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders honest unsupported capture and starts missing ASR download", async () => {
    const startModelDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue(makeModelsStatus("missing")),
          startModelDownload,
        })}
      />
    );

    expect(await screen.findByText("Unsupported")).toBeInTheDocument();
    expect(screen.getByText("Manual only")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("Download starts automatically before recording.")).toBeInTheDocument();
    await waitFor(() => {
      expect(startModelDownload).toHaveBeenCalledWith({ role: "audio-transcript" });
    });
  });

  it("creates a manual voice note from the primary action", async () => {
    const snapshot: ExplorerSnapshot = { roots: [makeExplorerNote()] };
    const client = makeClient();
    vi.mocked(client.create).mockResolvedValue({
      voiceNote: makeVoiceNote({ noteId: "created-1" }),
      snapshot,
    });
    renderWithExplorerStore(
      <VoiceNotePanel
        client={client}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue(makeModelsStatus("ready")),
        })}
      />
    );

    await screen.findByText("No voice notes yet.");
    fireEvent.click(screen.getByRole("button", { name: /New voice note/i }));

    await waitFor(() => {
      expect(client.create).toHaveBeenCalledWith({});
    });
    expect(await screen.findByText("Untitled Voice Note")).toBeInTheDocument();
    expect(screen.getByText("Voice note created.")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-root-count")).toHaveTextContent("1");
  });

  it("keeps locally created notes visible across stale refresh results", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        voiceNote: makeVoiceNote({ noteId: "created-1" }),
        snapshot: { roots: [] },
      }),
    });
    render(
      <VoiceNotePanel
        client={client}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue(makeModelsStatus("ready")),
        })}
      />
    );

    await screen.findByText("No voice notes yet.");
    fireEvent.click(screen.getByRole("button", { name: /New voice note/i }));
    expect(await screen.findByText("Untitled Voice Note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh voice notes/i }));

    await waitFor(() => {
      expect(client.list).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Untitled Voice Note")).toBeInTheDocument();
  });

  it("shows ASR ready when the audio transcript role is ready", async () => {
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue(makeModelsStatus("ready")),
        })}
      />
    );

    expect(await screen.findByText("Qwen3-ASR 0.6B")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Qwen/Qwen3-ASR-0.6B")).toBeInTheDocument();
  });

  it("shows non-ready ASR role states when the role is present", async () => {
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue(makeModelsStatus("downloading")),
        })}
      />
    );

    expect(await screen.findByText("Downloading")).toBeInTheDocument();
    expect(screen.getByText("Qwen/Qwen3-ASR-0.6B")).toBeInTheDocument();
  });
});
