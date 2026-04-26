import { describe, expect, it } from "vitest";
import {
  formatCompactNodeMeta,
  formatTreeDisclosurePath,
} from "./presentation";
import type { ExplorerNode } from "../types/explorer";

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

describe("presentation compact tree helpers", () => {
  it("keeps file rows free of type labels", () => {
    expect(formatCompactNodeMeta(node({ name: "README.md" }))).toBe("");
  });

  it("keeps ready folders visually quiet", () => {
    expect(
      formatCompactNodeMeta(
        node({
          kind: "folder",
          name: "docs",
          children: [node({ id: "child-1", name: "a.md" }), node({ id: "child-2", name: "b.md" })],
        })
      )
    ).toBe("");
  });

  it("keeps url rows free of type labels", () => {
    expect(
      formatCompactNodeMeta(
        node({
          kind: "url",
          name: "https://example.com",
          state: "pending",
          sizeBytes: 0,
        })
      )
    ).toBe("");
  });

  it("formats root-to-leaf disclosure paths", () => {
    expect(
      formatTreeDisclosurePath([
        node({ id: "root", kind: "mount", name: "workspace" }),
        node({ id: "folder", parentId: "root", kind: "folder", name: "docs" }),
        node({ id: "leaf", parentId: "folder", name: "README.md" }),
      ])
    ).toBe("workspace / docs / README.md");
  });

  it("keeps notes free of type labels", () => {
    expect(
      formatCompactNodeMeta(
        node({
          kind: "note",
          name: "Daily Note",
          modifiedAt: "not-a-date",
          sizeBytes: 512,
        })
      )
    ).toBe("");
  });

  it("keeps generic files free of type labels", () => {
    expect(
      formatCompactNodeMeta(
        node({
          name: "empty.txt",
          sizeBytes: 0,
        })
      )
    ).toBe("");
  });

  it("handles unexpected state values without adding text metadata", () => {
    expect(
      formatCompactNodeMeta(
        node({
          kind: "mount",
          name: "archive",
          state: "unavailable",
        })
      )
    ).toBe("");
  });
});
