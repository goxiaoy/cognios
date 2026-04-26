import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerLayout } from "./ExplorerLayout";
import type { ExplorerClient } from "../types/explorer";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    close: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

function makeClient(): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({
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
              id: "file-1",
              parentId: "mount-1",
              name: "long-file-name-that-needs-more-room-than-default.md",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-26 00:00:00",
              modifiedAt: "2026-04-26 00:00:00",
              sizeBytes: 2048,
              children: [],
            },
          ],
        },
      ],
    }),
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
}

describe("ExplorerLayout", () => {
  beforeEach(() => {
    document.body.classList.remove("is-resizing-pane");
  });

  afterEach(() => {
    cleanup();
  });

  it("drags the tree separator within clamped bounds", async () => {
    render(<ExplorerLayout active={true} client={makeClient()} />);

    await screen.findByText("long-file-name-that-needs-more-room-than-default.md");

    const workspace = screen.getByTestId("explorer-workspace");
    const separator = screen.getByRole("separator", { name: /resize file tree/i });

    expect(workspace).toHaveStyle({ gridTemplateColumns: "240px 10px minmax(0, 1fr) 280px" });

    fireEvent.mouseDown(separator, { clientX: 240 });
    fireEvent.mouseMove(document, { clientX: 340 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(workspace).toHaveStyle({ gridTemplateColumns: "340px 10px minmax(0, 1fr) 280px" });
    });

    fireEvent.mouseDown(separator, { clientX: 340 });
    fireEvent.mouseMove(document, { clientX: -400 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      expect(workspace).toHaveStyle({ gridTemplateColumns: "208px 10px minmax(0, 1fr) 280px" });
    });
  });

  it("keeps pane scroll containers independent", async () => {
    const { container } = render(<ExplorerLayout active={true} client={makeClient()} />);

    await screen.findByText("long-file-name-that-needs-more-room-than-default.md");

    const treeScroll = container.querySelector(".explorer-tree") as HTMLDivElement;
    const detailScroll = container.querySelector(".detail-surface-scroll") as HTMLDivElement;
    const inspectorScroll = container.querySelector(".inspector-panel-scroll") as HTMLDivElement;

    expect(treeScroll).toBeTruthy();
    expect(detailScroll).toBeTruthy();
    expect(inspectorScroll).toBeTruthy();

    treeScroll.scrollTop = 14;
    inspectorScroll.scrollTop = 21;
    detailScroll.scrollTop = 55;
    fireEvent.scroll(detailScroll);

    expect(treeScroll.scrollTop).toBe(14);
    expect(inspectorScroll.scrollTop).toBe(21);
    expect(detailScroll.scrollTop).toBe(55);
  });
});
