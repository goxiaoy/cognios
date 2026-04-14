import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExplorerContentGrid } from "./ExplorerContentGrid";

const nodes = [
  {
    id: "b",
    parentId: "root",
    name: "zeta.md",
    kind: "file",
    state: "ready",
    createdAt: "2026-04-13 00:00:00",
    modifiedAt: "2026-04-13 00:00:00",
    sizeBytes: 32,
    children: []
  },
  {
    id: "a",
    parentId: "root",
    name: "alpha.png",
    kind: "file",
    state: "ready",
    createdAt: "2026-04-12 00:00:00",
    modifiedAt: "2026-04-12 00:00:00",
    sizeBytes: 64,
    children: []
  }
] as const;

const baseProps = {
  breadcrumbs: [],
  loadThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
  pendingInlineRenameId: null,
  selectedIds: [] as string[],
  selectionCount: 0,
  onActivate: vi.fn(),
  onBreadcrumbSelect: vi.fn(),
  onCreateSelect: vi.fn(),
  onDelete: vi.fn(),
  onInlineRename: vi.fn(),
  onRetry: vi.fn(),
  onSelect: vi.fn(),
  onStartRename: vi.fn(),
  onViewModeChange: vi.fn()
};

describe("ExplorerContentGrid", () => {
  it("renders list mode name-sorted and forwards selection", () => {
    const onSelect = vi.fn();

    render(
      <ExplorerContentGrid
        {...baseProps}
        nodes={nodes as never}
        onSelect={onSelect}
        viewMode="list"
      />
    );

    const cards = screen.getAllByRole("button").filter((button) =>
      button.className.includes("artifact-card")
    );
    expect(cards[0]).toHaveTextContent("alpha.png");
    expect(cards[1]).toHaveTextContent("zeta.md");

    fireEvent.click(cards[0]);
    expect(onSelect).toHaveBeenCalledWith("a", false);
  });

  it("renders required date buckets in date mode", () => {
    render(
      <ExplorerContentGrid
        {...baseProps}
        nodes={nodes as never}
        viewMode="date"
      />
    );

    expect(
      screen.getAllByText(/Today|Yesterday|This Week|Earlier/i).length
    ).toBeGreaterThan(0);
  });

  it("shows breadcrumb ancestors and current folder name", () => {
    render(
      <ExplorerContentGrid
        {...baseProps}
        breadcrumbs={[
          { id: "p", parentId: null, name: "Projects", kind: "folder", state: "ready",
            createdAt: "", modifiedAt: "", sizeBytes: 0, children: [] },
          { id: "c", parentId: "p", name: "Code", kind: "folder", state: "ready",
            createdAt: "", modifiedAt: "", sizeBytes: 0, children: [] }
        ] as never}
        nodes={[] as never}
        viewMode="grid"
      />
    );

    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Code")).toBeInTheDocument();
  });
});
