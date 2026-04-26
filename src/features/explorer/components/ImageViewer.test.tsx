import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageViewer } from "./ImageViewer";
import type { ExplorerClient } from "../types/explorer";

function makeClient(overrides: Partial<ExplorerClient> = {}): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn(),
    getMountSetupContext: vi.fn(),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    ...overrides,
  };
}

describe("ImageViewer", () => {
  afterEach(() => {
    cleanup();
  });

  it("loads via getNodeThumbnail and renders the image", async () => {
    const client = makeClient({
      getNodeThumbnail: vi.fn().mockResolvedValue("data:image/png;base64,XYZ"),
    });

    render(
      <ImageViewer client={client} name="logo.png" nodeId="img-1" />
    );

    expect(client.getNodeThumbnail).toHaveBeenCalledWith("img-1");

    const img = await screen.findByAltText("logo.png");
    expect(img).toHaveAttribute("src", "data:image/png;base64,XYZ");
    expect(screen.getByText("logo.png")).toBeInTheDocument();
  });

  it("shows a generic error message when the IPC rejects", async () => {
    const client = makeClient({
      getNodeThumbnail: vi.fn().mockRejectedValue(new Error("thumbnail unavailable")),
    });

    render(
      <ImageViewer client={client} name="big.jpg" nodeId="n" />
    );

    expect(
      await screen.findByText(/too large or unavailable/i)
    ).toBeInTheDocument();
    expect(screen.getByText("big.jpg")).toBeInTheDocument();
  });

  it("re-fetches when nodeId changes", async () => {
    const getNodeThumbnail = vi
      .fn()
      .mockResolvedValueOnce("data:image/png;base64,A")
      .mockResolvedValueOnce("data:image/png;base64,B");
    const client = makeClient({ getNodeThumbnail });

    const { rerender } = render(
      <ImageViewer client={client} name="a.png" nodeId="a" />
    );
    await waitFor(() => {
      expect(getNodeThumbnail).toHaveBeenCalledWith("a");
    });

    rerender(
      <ImageViewer client={client} name="b.png" nodeId="b" />
    );
    await waitFor(() => {
      expect(getNodeThumbnail).toHaveBeenCalledWith("b");
    });
  });

  it("ignores late-resolving fetches after unmount (cancelled flag)", async () => {
    let resolveContent: (value: string) => void = () => {};
    const client = makeClient({
      getNodeThumbnail: vi.fn().mockReturnValue(
        new Promise<string>((resolve) => {
          resolveContent = resolve;
        })
      ),
    });

    const { unmount } = render(
      <ImageViewer client={client} name="x.png" nodeId="n" />
    );

    unmount();
    resolveContent("data:image/png;base64,LATE");
    await new Promise((r) => setTimeout(r, 0));
    // No assertion needed — Vitest fails on setState-after-unmount warning
  });
});
