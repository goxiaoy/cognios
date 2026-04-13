import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useExplorerStore } from "./useExplorerStore";

describe("useExplorerStore", () => {
  it("hydrates snapshot state and derives breadcrumbs for the selected node", async () => {
    const snapshot = {
      roots: [
        {
          id: "root",
          parentId: null,
          name: "Root",
          kind: "folder",
          state: "ready",
          children: [
            {
              id: "child",
              parentId: "root",
              name: "Child",
              kind: "folder",
              state: "ready",
              children: []
            }
          ]
        }
      ]
    };
    const client = {
      getExplorerSnapshot: vi.fn().mockResolvedValue(snapshot),
      createFolder: vi.fn(),
      createMount: vi.fn(),
      createUrl: vi.fn(),
      renameNode: vi.fn(),
      deleteNode: vi.fn(),
      retryUrl: vi.fn()
    };

    const { result } = renderHook(() => useExplorerStore(client));

    await act(async () => {
      await result.current.refresh();
    });

    act(() => {
      result.current.selectNode("child");
    });

    expect(result.current.snapshot.roots).toHaveLength(1);
    expect(result.current.selectedNode?.name).toBe("Child");
    expect(result.current.breadcrumbs.map((node) => node.name)).toEqual([
      "Root",
      "Child"
    ]);
  });
});
