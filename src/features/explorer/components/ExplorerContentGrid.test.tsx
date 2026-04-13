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

describe("ExplorerContentGrid", () => {
  it("renders list mode name-sorted and forwards selection", () => {
    const onSelect = vi.fn();

    render(
      <ExplorerContentGrid
        displayedFolderName="Inbox"
        loadThumbnail={vi.fn().mockResolvedValue("data:image/png;base64,AA==")}
        nodes={nodes as never}
        onActivate={vi.fn()}
        onSelect={onSelect}
        onViewModeChange={vi.fn()}
        selectedIds={[]}
        selectionCount={0}
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
        displayedFolderName="Inbox"
        loadThumbnail={vi.fn().mockResolvedValue("data:image/png;base64,AA==")}
        nodes={nodes as never}
        onActivate={vi.fn()}
        onSelect={vi.fn()}
        onViewModeChange={vi.fn()}
        selectedIds={[]}
        selectionCount={0}
        viewMode="date"
      />
    );

    expect(
      screen.getAllByText(/Today|Yesterday|This Week|Earlier/i).length
    ).toBeGreaterThan(0);
  });
});
