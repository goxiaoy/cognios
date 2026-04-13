import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const getExplorerSnapshot = vi.fn();
const createFolder = vi.fn();
const createMount = vi.fn();
const createUrl = vi.fn();

vi.mock("../lib/tauri/ipc", () => ({
  getExplorerSnapshot: () => getExplorerSnapshot(),
  getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
  createFolder: (input: unknown) => createFolder(input),
  createMount: (input: unknown) => createMount(input),
  createUrl: (input: unknown) => createUrl(input),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
  retryUrl: vi.fn()
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => Promise.resolve())
}));

describe("App", () => {
  beforeEach(() => {
    getExplorerSnapshot.mockReset();
    createFolder.mockReset();
    createMount.mockReset();
    createUrl.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty explorer state from the backend snapshot", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });

    render(<App />);

    expect(screen.getByRole("button", { name: /Explorer/i })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByText(/No nodes yet/i)).toBeInTheDocument();
  });

  it("submits a new folder and renders it in the tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createFolder.mockResolvedValue({
      roots: [
        {
          id: "folder-1",
          parentId: null,
          name: "Untitled",
          kind: "folder",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: []
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    // The create dropdown items are in the DOM even when CSS-hidden
    fireEvent.click(screen.getByRole("menuitem", { name: /New Folder/i }));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith({
        name: "Untitled",
        parentId: undefined
      });
    });

    expect((await screen.findAllByText("Untitled")).length).toBeGreaterThan(0);
  });

  it("submits a mount path and renders the mounted tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createMount.mockResolvedValue({
      roots: [
        {
          id: "mount-1",
          parentId: null,
          name: "workspace",
          kind: "mount",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 4,
          children: [
            {
              id: "file-1",
              parentId: "mount-1",
              name: "notes.txt",
              kind: "file",
              state: "ready",
              createdAt: "2026-04-13 00:00:00",
              modifiedAt: "2026-04-13 00:00:00",
              sizeBytes: 4,
              children: []
            }
          ]
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    // Open mount modal from the dropdown (CSS-hidden but queryable in JSDOM)
    fireEvent.click(screen.getByRole("menuitem", { name: /Mount Directory/i }));

    fireEvent.change(screen.getByPlaceholderText(/~\/projects\/example/i), {
      target: { value: "~/workspace" }
    });
    fireEvent.click(screen.getByRole("button", { name: /^Mount$/i }));

    await waitFor(() => {
      expect(createMount).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "~/workspace",
          parentId: undefined
        })
      );
    });

    expect((await screen.findAllByText("workspace")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("notes.txt")).length).toBeGreaterThan(0);
  });

  it("submits a url and renders the pending node immediately", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createUrl.mockResolvedValue({
      roots: [
        {
          id: "url-1",
          parentId: null,
          name: "https://example.com",
          kind: "url",
          state: "pending",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: []
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    // Open URL modal from the dropdown
    fireEvent.click(screen.getByRole("menuitem", { name: /Add URL/i }));

    fireEvent.change(screen.getByPlaceholderText(/https:\/\/example.com/i), {
      target: { value: "https://example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Fetch & Create/i }));

    await waitFor(() => {
      expect(createUrl).toHaveBeenCalledWith({
        url: "https://example.com",
        parentId: undefined
      });
    });

    expect((await screen.findAllByText("https://example.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("pending")).length).toBeGreaterThan(0);
  });

  it("keeps explorer state when switching to another shell section and back", async () => {
    getExplorerSnapshot.mockResolvedValue({
      roots: [
        {
          id: "folder-1",
          parentId: null,
          name: "Inbox",
          kind: "folder",
          state: "ready",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 0,
          children: []
        }
      ]
    });

    render(<App />);

    expect(await screen.findAllByText("Inbox")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /^Home$/i }));
    expect(screen.getByText(/This section is stubbed in Milestone 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Explorer$/i }));
    expect((await screen.findAllByText("Inbox")).length).toBeGreaterThan(0);
    expect(getExplorerSnapshot).toHaveBeenCalledTimes(1);
  });
});
