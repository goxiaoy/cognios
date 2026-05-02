import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { useModelDownloadProgress } from "./useModelDownloadProgress";
import type { ModelDownloadEvent } from "../../../lib/contracts/search";

type Listener = (event: { payload: ModelDownloadEvent }) => void;

let activeListener: Listener | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: Listener) => {
    activeListener = cb;
    return unlisten;
  }),
}));

afterEach(() => {
  cleanup();
  activeListener = null;
  unlisten.mockReset();
});

function Probe({ onProgress }: { onProgress(map: Record<string, ModelDownloadEvent>): void }) {
  const map = useModelDownloadProgress();
  onProgress(map);
  return null;
}

describe("useModelDownloadProgress", () => {
  it("starts with an empty map and updates on each event payload", async () => {
    let latest: Record<string, ModelDownloadEvent> = {};
    render(<Probe onProgress={(m) => (latest = m)} />);
    // Wait for the listen() promise to resolve so activeListener is set.
    await Promise.resolve();
    expect(latest).toEqual({});
    expect(activeListener).not.toBeNull();

    act(() => {
      activeListener!({
        payload: {
          role: "embedding",
          state: "downloading",
          bytesDownloaded: 1024,
          bytesTotal: 100_000,
        },
      });
    });
    expect(latest.embedding).toEqual({
      role: "embedding",
      state: "downloading",
      bytesDownloaded: 1024,
      bytesTotal: 100_000,
    });

    act(() => {
      activeListener!({
        payload: {
          role: "reranker",
          state: "verifying",
          bytesDownloaded: 50_000,
          bytesTotal: 50_000,
        },
      });
    });
    expect(Object.keys(latest)).toEqual(["embedding", "reranker"]);
  });

  it("calls the unlisten function on unmount", async () => {
    const { unmount } = render(<Probe onProgress={() => {}} />);
    await Promise.resolve();
    unmount();
    // Unlisten is invoked from the cleanup .then; await one microtask.
    await new Promise((r) => setTimeout(r, 0));
    expect(unlisten).toHaveBeenCalled();
  });
});
