import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExplorerTree } from "./ExplorerTree";

const tree = [
  {
    id: "root",
    parentId: null,
    name: "Workspace",
    kind: "folder",
    state: "ready",
    children: [
      {
        id: "child",
        parentId: "root",
        name: "Readme.md",
        kind: "file",
        state: "ready",
        children: []
      }
    ]
  }
] as const;

describe("ExplorerTree", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nested rows when the parent is expanded", () => {
    render(
      <ExplorerTree
        expandedIds={["root"]}
        nodes={tree as never}
        onRetry={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        selectedId={null}
      />
    );

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Readme.md")).toBeInTheDocument();
  });

  it("calls select and toggle handlers", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();

    render(
      <ExplorerTree
        expandedIds={[]}
        nodes={tree as never}
        onRetry={vi.fn()}
        onSelect={onSelect}
        onToggle={onToggle}
        selectedId={null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Expand node/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /Workspace/i })[0]);

    expect(onToggle).toHaveBeenCalledWith("root");
    expect(onSelect).toHaveBeenCalledWith("root");
  });
});
