import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerInspector } from "./ExplorerInspector";
import type { ExplorerClient } from "../types/explorer";

// Inspector now optionally renders an image thumbnail via the
// ExplorerClient — provide a stub for the shape so the test
// harness stays decoupled from the IPC layer.
function makeClient(): ExplorerClient {
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
    getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn().mockResolvedValue(undefined),
    retranscribeVoiceNote: vi.fn().mockResolvedValue({}),
    listTopicMemoriesForNode: vi.fn().mockResolvedValue([]),
  };
}

describe("ExplorerInspector", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows url indexing state in single-node mode", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "url-1",
          parentId: null,
          name: "Example",
          kind: "url",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 128,
          children: []
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    // Inspector now renders the index state as a colored pill
    // ("Indexed" / "Pending" / "Error" / "Not indexable") instead
    // of the raw state value.
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    expect(screen.getByText(/WEB LINK/i)).toBeInTheDocument();
    expect(screen.getByText("Node ID")).toBeInTheDocument();
    expect(screen.getByText("url-1")).toBeInTheDocument();
  });

  it("shows detailed processing stages when node status is available", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "voice-1",
          parentId: null,
          name: "Voice Note",
          kind: "note",
          state: "indexed",
          createdAt: "2026-06-06 00:00:00",
          modifiedAt: "2026-06-06 00:00:00",
          sizeBytes: 512,
          isVoiceNote: true,
          children: [],
        }}
        nodeStatus={{
          nodeId: "voice-1",
          overall: "partial",
          primaryStageId: "voice.summarize",
          updatedAt: "2026-06-06 00:00:00",
          stages: [
            {
              id: "voice.transcribe",
              label: "Transcribing",
              state: "succeeded",
              importance: "required",
              message: "Transcript completed",
              attempt: 0,
              updatedAt: "2026-06-06 00:00:00",
            },
            {
              id: "voice.summarize",
              label: "Summarizing",
              state: "failed",
              importance: "optional",
              error: { message: "Provider unavailable", retryable: true },
              attempt: 1,
              updatedAt: "2026-06-06 00:00:00",
            },
          ],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(screen.getByText("Partially ready")).toBeInTheDocument();
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
  });

  it("hides skipped optional processing stages", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "voice-1",
          parentId: null,
          name: "Voice Note",
          kind: "note",
          state: "indexed",
          createdAt: "2026-06-06 00:00:00",
          modifiedAt: "2026-06-06 00:00:00",
          sizeBytes: 512,
          isVoiceNote: true,
          children: [],
        }}
        nodeStatus={{
          nodeId: "voice-1",
          overall: "ready",
          primaryStageId: null,
          updatedAt: "2026-06-06 00:00:00",
          stages: [
            {
              id: "voice.transcribe",
              label: "Transcribing",
              state: "succeeded",
              importance: "required",
              message: "Transcript completed",
              attempt: 0,
              updatedAt: "2026-06-06 00:00:00",
            },
            {
              id: "voice.summarize",
              label: "Summarizing",
              state: "skipped",
              importance: "optional",
              message: "Summary unavailable",
              attempt: 0,
              updatedAt: "2026-06-06 00:00:00",
            },
          ],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("Transcribing")).toBeInTheDocument();
    expect(screen.queryByText("Summarizing")).not.toBeInTheDocument();
    expect(screen.queryByText("Summary unavailable")).not.toBeInTheDocument();
  });

  it("starts retranscription for voice notes", async () => {
    const client = makeClient();
    render(
      <ExplorerInspector
        client={client}
        node={{
          id: "voice-1",
          parentId: null,
          name: "Voice Note",
          kind: "note",
          state: "indexed",
          createdAt: "2026-06-06 00:00:00",
          modifiedAt: "2026-06-06 00:00:00",
          sizeBytes: 512,
          isVoiceNote: true,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Retranscribe" }));

    await waitFor(() =>
      expect(client.retranscribeVoiceNote).toHaveBeenCalledWith("voice-1")
    );
    expect(screen.getByText("Retranscription started.")).toBeInTheDocument();
  });

  it("shows related topic memories for the selected node", async () => {
    const client = makeClient();
    vi.mocked(client.listTopicMemoriesForNode!).mockResolvedValue([
      {
        id: "topic-1",
        title: "Atlas",
        summary: "Launch memory.",
        status: "active",
        confidence: 0.91,
        rationale: "Cited evidence.",
        createdAt: "now",
        updatedAt: "now",
      },
    ]);
    const onActivateTopic = vi.fn();

    render(
      <ExplorerInspector
        client={client}
        node={{
          id: "meeting-1",
          parentId: null,
          name: "Meeting Alpha",
          kind: "note",
          state: "indexed",
          createdAt: "2026-06-06 00:00:00",
          modifiedAt: "2026-06-06 00:00:00",
          sizeBytes: 512,
          children: [],
        }}
        onActivateTopic={onActivateTopic}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(client.listTopicMemoriesForNode).toHaveBeenCalledWith({
      nodeId: "meeting-1",
    });
    const topic = await screen.findByRole("button", { name: /Atlas/i });
    expect(screen.getByText("91% confidence")).toBeInTheDocument();
    fireEvent.click(topic);
    expect(onActivateTopic).toHaveBeenCalledWith("topic-1");
  });

  it("copies the node id from single-node metadata", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      render(
        <ExplorerInspector
          client={makeClient()}
          node={{
            id: "node-123",
            parentId: null,
            name: "Copy me",
            kind: "note",
            state: "ready",
            createdAt: "2026-04-14 00:00:00",
            modifiedAt: "2026-04-14 01:00:00",
            sizeBytes: 512,
            children: [],
          }}
          selectedArtifacts={[]}
          selectionCount={0}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /copy node id/i }));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith("node-123");
      });
      expect(
        screen.getByRole("button", { name: /copied node id/i })
      ).toBeInTheDocument();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    }
  });

  it("shows note metadata with NOTE kind label and size", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "note-1",
          parentId: null,
          name: "My Research",
          kind: "note",
          state: "ready",
          createdAt: "2026-04-14 00:00:00",
          modifiedAt: "2026-04-14 01:00:00",
          sizeBytes: 512,
          children: []
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(screen.getByText(/NOTE/)).toBeInTheDocument();
    expect(screen.getByText("My Research")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
  });

  it("does not repeat the title in the voice note kind label", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "voice-1",
          parentId: null,
          name: "2026-05-17 15.03.12",
          kind: "note",
          state: "ready",
          createdAt: "2026-05-17 15:03:12",
          modifiedAt: "2026-05-17 15:04:12",
          sizeBytes: 2048,
          children: [],
          isVoiceNote: true,
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(screen.getByText("2026-05-17 15.03.12")).toBeInTheDocument();
    expect(screen.getByText("VOICE NOTE")).toBeInTheDocument();
    expect(screen.queryByText(/VOICE NOTE\s+.\s+2026-05-17/i)).not.toBeInTheDocument();
  });

  it("shows aggregate metadata during multi-select", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={null}
        selectedArtifacts={[
          {
            id: "a",
            parentId: "root",
            name: "alpha.png",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-13 00:00:00",
            modifiedAt: "2026-04-13 00:00:00",
            sizeBytes: 32,
            children: []
          },
          {
            id: "b",
            parentId: "root",
            name: "beta.png",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-13 00:00:00",
            modifiedAt: "2026-04-13 00:00:00",
            sizeBytes: 64,
            children: []
          }
        ]}
        selectionCount={2}
      />
    );

    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("96 B")).toBeInTheDocument();
  });

  it("shows empty placeholder when no node and selectionCount is 0", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={null}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );
    expect(screen.getByText("No selection")).toBeInTheDocument();
  });

  it("renders an inline image thumbnail in the inspector for image nodes", async () => {
    const client = makeClient();
    render(
      <ExplorerInspector
        client={client}
        node={{
          id: "img-1",
          parentId: null,
          name: "diagram.png",
          kind: "file",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 1024,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );
    expect(client.getNodeThumbnail).toHaveBeenCalledWith("img-1");
    // Wait for the async image to render.
    await screen.findByAltText("diagram.png");
  });

  it("opens the inspector image preview on double click", async () => {
    const client = makeClient();
    render(
      <ExplorerInspector
        client={client}
        node={{
          id: "img-1",
          parentId: null,
          name: "diagram.png",
          kind: "file",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 1024,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    const thumb = await screen.findByRole("button", {
      name: /open image preview for diagram\.png/i,
    });
    fireEvent.doubleClick(thumb);

    expect(
      screen.getByRole("dialog", { name: /image preview: diagram\.png/i })
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: /image preview: diagram\.png/i })
    ).not.toBeInTheDocument();
  });

  it("reveals extracted artifacts for image and PDF nodes", async () => {
    const imageClient = makeClient();
    const { rerender } = render(
      <ExplorerInspector
        client={imageClient}
        node={{
          id: "img-1",
          parentId: null,
          name: "diagram.png",
          kind: "file",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 1024,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /reveal extracted/i }));
    await waitFor(() => {
      expect(imageClient.showNodeExtractArtifacts).toHaveBeenCalledWith("img-1");
    });

    const pdfClient = makeClient();
    rerender(
      <ExplorerInspector
        client={pdfClient}
        node={{
          id: "pdf-1",
          parentId: null,
          name: "scan.pdf",
          kind: "file",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 2048,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /reveal extracted/i }));
    await waitFor(() => {
      expect(pdfClient.showNodeExtractArtifacts).toHaveBeenCalledWith("pdf-1");
    });
  });

  it("does not show extracted artifacts action for regular documents", () => {
    render(
      <ExplorerInspector
        client={makeClient()}
        node={{
          id: "doc-1",
          parentId: null,
          name: "notes.md",
          kind: "file",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 1024,
          children: [],
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(
      screen.queryByRole("button", { name: /reveal extracted/i })
    ).not.toBeInTheDocument();
  });
});
