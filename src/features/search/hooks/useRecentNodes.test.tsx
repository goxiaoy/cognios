import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExplorerStoreProvider } from "../../explorer/store/ExplorerStoreContext";
import type {
  ExplorerClient,
  ExplorerNode,
  ExplorerSnapshot,
} from "../../explorer/types/explorer";
import { useExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import { useRecentNodes } from "./useRecentNodes";

function makeNode(overrides: Partial<ExplorerNode>): ExplorerNode {
  return {
    id: "x",
    parentId: null,
    name: "Untitled.md",
    kind: "note",
    state: "ready",
    createdAt: "2026-04-01T00:00:00Z",
    modifiedAt: "2026-04-01T00:00:00Z",
    sizeBytes: 0,
    children: [],
    ...overrides,
  } as ExplorerNode;
}

function makeClient(): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({ roots: [] }),
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
    getNoteContent: vi.fn().mockResolvedValue(""),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn().mockResolvedValue(""),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
  };
}

interface ProbeRef {
  apply(snapshot: ExplorerSnapshot): void;
  recent: ExplorerNode[];
}

function Probe({ probeRef }: { probeRef: { current: ProbeRef | null } }) {
  const store = useExplorerStoreContext();
  const recent = useRecentNodes();
  probeRef.current = {
    apply: store.applySnapshot,
    recent,
  };
  return null;
}

afterEach(() => cleanup());

describe("useRecentNodes", () => {
  it("returns empty when the snapshot is empty", () => {
    const probe: { current: ProbeRef | null } = { current: null };
    render(
      <ExplorerStoreProvider client={makeClient()}>
        <Probe probeRef={probe} />
      </ExplorerStoreProvider>
    );
    expect(probe.current?.recent).toEqual([]);
  });

  it("orders by most-recent modifiedAt", () => {
    const probe: { current: ProbeRef | null } = { current: null };
    render(
      <ExplorerStoreProvider client={makeClient()}>
        <Probe probeRef={probe} />
      </ExplorerStoreProvider>
    );

    act(() => {
      probe.current!.apply({
        roots: [
          makeNode({ id: "old", name: "Old", modifiedAt: "2026-04-01T00:00:00Z" }),
          makeNode({ id: "new", name: "New", modifiedAt: "2026-04-26T00:00:00Z" }),
          makeNode({ id: "mid", name: "Mid", modifiedAt: "2026-04-15T00:00:00Z" }),
        ],
      });
    });

    expect(probe.current!.recent.map((n) => n.id)).toEqual(["new", "mid", "old"]);
  });

  it("walks nested children", () => {
    const probe: { current: ProbeRef | null } = { current: null };
    render(
      <ExplorerStoreProvider client={makeClient()}>
        <Probe probeRef={probe} />
      </ExplorerStoreProvider>
    );

    act(() => {
      probe.current!.apply({
        roots: [
          makeNode({
            id: "folder",
            kind: "folder",
            name: "Inbox",
            modifiedAt: "2026-04-10T00:00:00Z",
            children: [
              makeNode({
                id: "child",
                name: "Child",
                modifiedAt: "2026-04-26T00:00:00Z",
              }),
            ],
          }),
        ],
      });
    });

    const ids = probe.current!.recent.map((n) => n.id);
    expect(ids).toContain("child");
    expect(ids[0]).toBe("child");
  });

  it("caps the result list at 10 by default", () => {
    const probe: { current: ProbeRef | null } = { current: null };
    render(
      <ExplorerStoreProvider client={makeClient()}>
        <Probe probeRef={probe} />
      </ExplorerStoreProvider>
    );

    const roots = Array.from({ length: 20 }, (_, i) =>
      makeNode({
        id: `n-${i}`,
        name: `Node ${i}`,
        modifiedAt: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      })
    );
    act(() => {
      probe.current!.apply({ roots });
    });

    expect(probe.current!.recent).toHaveLength(10);
    // The most-recent ids should win.
    expect(probe.current!.recent[0].id).toBe("n-19");
  });
});
