import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const getExplorerSnapshot = vi.fn();
const createFolder = vi.fn();
const createMount = vi.fn();
const createUrl = vi.fn();

vi.mock("../lib/tauri/ipc", () => ({
  getExplorerSnapshot: () => getExplorerSnapshot(),
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

    expect(await screen.findByText(/No nodes yet/i)).toBeInTheDocument();
  });

  it("submits a new folder and renders it in the tree", async () => {
    getExplorerSnapshot.mockResolvedValue({ roots: [] });
    createFolder.mockResolvedValue({
      roots: [
        {
          id: "folder-1",
          parentId: null,
          name: "Inbox",
          kind: "folder",
          state: "ready",
          children: []
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    fireEvent.change(screen.getByPlaceholderText(/New folder/i), {
      target: { value: "Inbox" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Folder/i }));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith({
        name: "Inbox",
        parentId: undefined
      });
    });

    expect((await screen.findAllByText("Inbox")).length).toBeGreaterThan(0);
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
          children: [
            {
              id: "file-1",
              parentId: "mount-1",
              name: "notes.txt",
              kind: "file",
              state: "ready",
              children: []
            }
          ]
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    fireEvent.change(screen.getByPlaceholderText(/~\/projects\/example/i), {
      target: { value: "~/workspace" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Mount/i }));

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
          children: []
        }
      ]
    });

    render(<App />);

    await screen.findByText(/No nodes yet/i);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/example.com/i), {
      target: { value: "https://example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Add URL/i }));

    await waitFor(() => {
      expect(createUrl).toHaveBeenCalledWith({
        url: "https://example.com",
        parentId: undefined
      });
    });

    expect((await screen.findAllByText("https://example.com")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("pending")).length).toBeGreaterThan(0);
  });
});
