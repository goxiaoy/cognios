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
    createdAt: "2026-04-26 00:00:00",
    modifiedAt: "2026-04-26 00:00:00",
    sizeBytes: 0,
    children: [
      {
        id: "child",
        parentId: "root",
        name: "Readme.md",
        kind: "file",
        state: "ready",
        createdAt: "2026-04-26 00:00:00",
        modifiedAt: "2026-04-26 00:00:00",
        sizeBytes: 2048,
        children: []
      }
    ]
  }
] as const;

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    expandedIds: ["root"] as string[],
    nodes: tree as never,
    pendingInlineRenameId: null,
    onDelete: vi.fn(),
    onDeleteMany: vi.fn(),
    onInlineRename: vi.fn(),
    onOpenUrl: vi.fn(),
    onRevealInFileManager: vi.fn(),
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onToggle: vi.fn(),
    selectedIds: [] as string[],
    ...overrides,
  };
}

describe("ExplorerTree", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nested rows when the parent is expanded", () => {
    render(<ExplorerTree {...defaultProps()} />);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Readme.md")).toBeInTheDocument();
    expect(screen.getByTitle("Workspace / Readme.md")).toBeInTheDocument();
  });

  it("calls onSelect with no modifiers on a plain click", () => {
    const onSelect = vi.fn();
    render(<ExplorerTree {...defaultProps({ onSelect })} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Workspace/i })[0]);

    expect(onSelect).toHaveBeenCalledWith("root", { shift: false, toggle: false });
  });

  it("calls onSelect with toggle=true when Cmd/Meta is held", () => {
    const onSelect = vi.fn();
    render(<ExplorerTree {...defaultProps({ onSelect })} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Workspace/i })[0], {
      metaKey: true,
    });

    expect(onSelect).toHaveBeenCalledWith("root", { shift: false, toggle: true });
  });

  it("calls onSelect with toggle=true when Ctrl is held", () => {
    const onSelect = vi.fn();
    render(<ExplorerTree {...defaultProps({ onSelect })} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Workspace/i })[0], {
      ctrlKey: true,
    });

    expect(onSelect).toHaveBeenCalledWith("root", { shift: false, toggle: true });
  });

  it("calls onSelect with shift=true when Shift is held", () => {
    const onSelect = vi.fn();
    render(<ExplorerTree {...defaultProps({ onSelect })} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Readme.md/i })[0], {
      shiftKey: true,
    });

    expect(onSelect).toHaveBeenCalledWith("child", { shift: true, toggle: false });
  });

  it("highlights every id in selectedIds", () => {
    const { container } = render(
      <ExplorerTree {...defaultProps({ selectedIds: ["root", "child"] })} />
    );

    const selectedRows = container.querySelectorAll(".tree-row.is-selected");
    expect(selectedRows.length).toBe(2);
  });

  it("calls onToggle when the chevron is clicked", () => {
    const onToggle = vi.fn();
    render(<ExplorerTree {...defaultProps({ expandedIds: [], onToggle })} />);

    fireEvent.click(screen.getByRole("button", { name: /Expand node/i }));
    expect(onToggle).toHaveBeenCalledWith("root");
  });

  it("renders the toolbar slot above the tree", () => {
    render(
      <ExplorerTree
        {...defaultProps()}
        toolbar={<button data-testid="tb-button">Create</button>}
      />
    );

    expect(screen.getByTestId("tb-button")).toBeInTheDocument();
  });

  it("does not render a toolbar container when no toolbar is provided", () => {
    const { container } = render(<ExplorerTree {...defaultProps()} />);
    expect(container.querySelector(".explorer-tree-toolbar")).toBeNull();
  });

  it("shows a reveal action for nodes with real paths", () => {
    const onRevealInFileManager = vi.fn();
    render(<ExplorerTree {...defaultProps({ onRevealInFileManager })} />);

    fireEvent.contextMenu(screen.getByText("Readme.md"));
    fireEvent.click(screen.getByRole("button", { name: /show in folder|show in finder|show in explorer/i }));

    expect(onRevealInFileManager).toHaveBeenCalledWith("child");
  });

  it("keeps the context menu inside the viewport near the bottom edge", () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 180,
    });
    render(<ExplorerTree {...defaultProps()} />);

    fireEvent.contextMenu(screen.getByText("Readme.md"), {
      clientX: 24,
      clientY: 172,
    });

    const menu = document.querySelector(".tree-context-menu") as HTMLElement;
    expect(menu).toBeTruthy();
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(45);
  });

  it("offers batch delete when right-clicking a multi-selected row", () => {
    const onDeleteMany = vi.fn();
    render(
      <ExplorerTree
        {...defaultProps({
          onDeleteMany,
          selectedIds: ["root", "child"],
        })}
      />
    );

    fireEvent.contextMenu(screen.getByText("Readme.md"));
    fireEvent.click(screen.getByRole("button", { name: /Delete 2 Items/i }));
    fireEvent.click(screen.getByRole("button", { name: /Delete 2 Items/i }));

    expect(onDeleteMany).toHaveBeenCalledWith(["root", "child"]);
  });
});
