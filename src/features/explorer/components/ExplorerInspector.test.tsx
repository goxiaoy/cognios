import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
  };
}

describe("ExplorerInspector", () => {
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

    expect(screen.getByText("indexed")).toBeInTheDocument();
    expect(screen.getByText(/WEB LINK/i)).toBeInTheDocument();
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
});
