import { describe, expect, it } from "vitest";
import type { ExplorerNode } from "../types/explorer";
import { sortExplorerTree } from "./treeSort";

function node(overrides: Partial<ExplorerNode> = {}): ExplorerNode {
  return {
    id: "node-1",
    parentId: null,
    name: "README.md",
    kind: "file",
    state: "ready",
    createdAt: "2026-04-26 00:00:00",
    modifiedAt: "2026-04-26 00:00:00",
    sizeBytes: 2048,
    children: [],
    ...overrides,
  };
}

describe("sortExplorerTree", () => {
  it("sorts siblings by created time descending by default option", () => {
    const sorted = sortExplorerTree(
      [
        node({ id: "old", name: "old.md", createdAt: "2026-04-20 00:00:00" }),
        node({ id: "new", name: "new.md", createdAt: "2026-04-26 00:00:00" }),
        node({ id: "mid", name: "mid.md", createdAt: "2026-04-24 00:00:00" }),
      ],
      "created-desc"
    );

    expect(sorted.map((item) => item.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts nested children with the same option", () => {
    const sorted = sortExplorerTree(
      [
        node({
          id: "root",
          kind: "folder",
          children: [
            node({ id: "b", parentId: "root", name: "b.md" }),
            node({ id: "a", parentId: "root", name: "a.md" }),
          ],
        }),
      ],
      "name-asc"
    );

    expect(sorted[0].children.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the original node order", () => {
    const nodes = [
      node({ id: "b", name: "b.md" }),
      node({ id: "a", name: "a.md" }),
    ];

    sortExplorerTree(nodes, "name-asc");

    expect(nodes.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
