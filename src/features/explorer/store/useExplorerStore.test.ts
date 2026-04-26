import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useExplorerStore } from "./useExplorerStore";

describe("useExplorerStore", () => {
  it("hydrates snapshot state and separates displayed folder from artifact selection", async () => {
    const snapshot = {
      roots: [
        {
          id: "root",
          parentId: null,
          name: "Root",
          kind: "folder",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 128,
          children: [
            {
              id: "child",
              parentId: "root",
              name: "Child",
              kind: "folder",
              state: "ready",
              createdAt: "2026-04-13 00:00:00",
              modifiedAt: "2026-04-13 00:00:00",
              sizeBytes: 64,
              children: [
                {
                  id: "leaf",
                  parentId: "child",
                  name: "notes.md",
                  kind: "file",
                  state: "ready",
                  createdAt: "2026-04-13 00:00:00",
                  modifiedAt: "2026-04-13 00:00:00",
                  sizeBytes: 64,
                  children: []
                }
              ]
            }
          ]
        }
      ]
    };
    const client = {
      getExplorerSnapshot: vi.fn().mockResolvedValue(snapshot),
      createFolder: vi.fn(),
      createMount: vi.fn(),
      createNote: vi.fn(),
      createUrl: vi.fn(),
      renameNode: vi.fn(),
      deleteNode: vi.fn(),
      retryUrl: vi.fn(),
      getNodeThumbnail: vi.fn(),
      getNoteContent: vi.fn(),
      saveNoteContent: vi.fn(),
      readFileContent: vi.fn(),
    };

    const { result } = renderHook(() => useExplorerStore(client));

    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.selectTreeNode("child");
      result.current.selectArtifact("leaf");
    });

    expect(result.current.snapshot.roots).toHaveLength(1);
    expect(result.current.displayedFolder?.name).toBe("Child");
    expect(result.current.inspectorNode?.name).toBe("notes.md");
    expect(result.current.breadcrumbs.map((node) => node.name)).toEqual([
      "Root",
      "Child"
    ]);
  });
});
