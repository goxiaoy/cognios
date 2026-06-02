import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useExplorerStore } from "./useExplorerStore";

function makeClient(snapshot: { roots: unknown[] }) {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue(snapshot),
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
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
  };
}

describe("useExplorerStore", () => {
  const baseSnapshot = {
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
            children: [],
          },
          {
            id: "note-1",
            parentId: "mount-1",
            name: "My Note",
            kind: "note",
            state: "ready",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 0,
            children: [],
          },
          {
            id: "md-1",
            parentId: "mount-1",
            name: "README.md",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 32,
            children: [],
          },
          {
            id: "img-1",
            parentId: "mount-1",
            name: "logo.png",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 1024,
            children: [],
          },
          {
            id: "pdf-1",
            parentId: "mount-1",
            name: "scan.pdf",
            kind: "file",
            state: "indexed",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 2048,
            children: [],
          },
          {
            id: "txt-1",
            parentId: "mount-1",
            name: "notes.txt",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 8,
            children: [],
          },
          {
            id: "json-1",
            parentId: "mount-1",
            name: "data.json",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 8,
            children: [],
          },
          {
            id: "url-1",
            parentId: "mount-1",
            name: "https://example.com",
            kind: "url",
            state: "indexed",
            createdAt: "2026-04-26 00:00:00",
            modifiedAt: "2026-04-26 00:00:00",
            sizeBytes: 0,
            children: [],
          },
        ],
      },
    ],
  };

  it("hydrates the snapshot and exposes nodes via inspectorNode on single selection", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.snapshot.roots).toHaveLength(1);
    expect(result.current.expandedIds).toContain("mount-1");

    act(() => {
      result.current.selectArtifact("note-1");
    });
    expect(result.current.selectionCount).toBe(1);
    expect(result.current.inspectorNode?.name).toBe("My Note");
  });

  it("activateArtifact on a folder toggles expansion and does not change active surfaces", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.expandedIds).not.toContain("folder-1");

    act(() => {
      result.current.activateArtifact("folder-1");
    });
    expect(result.current.expandedIds).toContain("folder-1");
    expect(result.current.activeNoteId).toBeNull();
    expect(result.current.activePreviewId).toBeNull();
    expect(result.current.activeImagePreviewId).toBeNull();

    // Toggling the same folder collapses it.
    act(() => {
      result.current.activateArtifact("folder-1");
    });
    expect(result.current.expandedIds).not.toContain("folder-1");
  });

  it("activateArtifact on a note sets activeNoteId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("note-1");
    });
    expect(result.current.activeNoteId).toBe("note-1");
    expect(result.current.activeNote?.name).toBe("My Note");
  });

  it("activateArtifact on a markdown file sets activePreviewId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("md-1");
    });
    expect(result.current.activePreviewId).toBe("md-1");
  });

  it("activateArtifact on a plain text file sets activePreviewId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("txt-1");
    });
    expect(result.current.activePreviewId).toBe("txt-1");
  });

  it("activateArtifact on an image file sets activeImagePreviewId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("img-1");
    });
    expect(result.current.activeImagePreviewId).toBe("img-1");
    expect(result.current.activeImagePreview?.name).toBe("logo.png");
  });

  it("activateArtifact on a PDF file sets activeImagePreviewId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("pdf-1");
    });
    expect(result.current.activeImagePreviewId).toBe("pdf-1");
    expect(result.current.activeImagePreview?.name).toBe("scan.pdf");
  });

  it("activateArtifact on an unsupported file kind does not set any surface", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("json-1");
    });
    expect(result.current.activeNoteId).toBeNull();
    expect(result.current.activePreviewId).toBeNull();
    expect(result.current.activeImagePreviewId).toBeNull();
  });

  it("activateArtifact on a URL sets activeImagePreviewId", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.activateArtifact("url-1");
    });
    expect(result.current.activeNoteId).toBeNull();
    expect(result.current.activePreviewId).toBeNull();
    expect(result.current.activeImagePreviewId).toBe("url-1");
    expect(result.current.activeImagePreview?.name).toBe("https://example.com");
  });

  it("replaceSelection sets the entire selection in one dispatch", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.replaceSelection(["note-1", "md-1", "img-1"]);
    });
    expect(result.current.selectedArtifactIds).toEqual(["note-1", "md-1", "img-1"]);
    expect(result.current.selectionCount).toBe(3);

    // Replacing with empty clears
    act(() => {
      result.current.replaceSelection([]);
    });
    expect(result.current.selectionCount).toBe(0);
  });

  it("selectArtifact additive=true toggles individual ids without affecting others", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.selectArtifact("note-1");
      result.current.selectArtifact("md-1", true);
    });
    expect(result.current.selectedArtifactIds).toEqual(["note-1", "md-1"]);

    act(() => {
      result.current.selectArtifact("note-1", true);
    });
    expect(result.current.selectedArtifactIds).toEqual(["md-1"]);
  });

  it("applySnapshot drops selection ids whose nodes were removed", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.replaceSelection(["note-1", "md-1"]);
    });
    expect(result.current.selectionCount).toBe(2);

    // Re-apply a snapshot where md-1 has been removed
    const trimmed = {
      roots: [
        {
          ...baseSnapshot.roots[0],
          children: baseSnapshot.roots[0].children.filter(
            (child: { id: string }) => child.id !== "md-1"
          ),
        },
      ],
    } as Parameters<typeof result.current.applySnapshot>[0];
    act(() => {
      result.current.applySnapshot(trimmed);
    });
    expect(result.current.selectedArtifactIds).toEqual(["note-1"]);
  });

  it("toggleNode flips expansion state", async () => {
    const client = makeClient(baseSnapshot);
    const { result } = renderHook(() => useExplorerStore(client));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.expandedIds).toContain("mount-1");
    act(() => {
      result.current.toggleNode("mount-1");
    });
    expect(result.current.expandedIds).not.toContain("mount-1");
    act(() => {
      result.current.toggleNode("mount-1");
    });
    expect(result.current.expandedIds).toContain("mount-1");
  });
});
