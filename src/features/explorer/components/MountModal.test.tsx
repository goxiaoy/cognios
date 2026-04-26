import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MountModal } from "./MountModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));

describe("MountModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders suggested Obsidian folders and applies one on click", () => {
    render(
      <MountModal
        isSubmitting={false}
        onClose={() => {}}
        onRevealMount={() => {}}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        setupContext={{
          suggestedFolders: [
            {
              name: "Second Brain",
              path: "/Users/test/Obsidian/Second Brain",
              source: "obsidian",
            },
          ],
          existingMounts: [],
        }}
        setupError={null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Second Brain/i }));

    expect(screen.getByDisplayValue("/Users/test/Obsidian/Second Brain")).toBeInTheDocument();
  });

  it("shows reveal button instead of submitting a duplicate mount", async () => {
    const onRevealMount = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <MountModal
        isSubmitting={false}
        onClose={() => {}}
        onRevealMount={onRevealMount}
        onSubmit={onSubmit}
        setupContext={{
          suggestedFolders: [],
          existingMounts: [
            {
              nodeId: "mount-1",
              name: "Second Brain",
              absolutePath: "/Users/test/Obsidian/Second Brain",
            },
          ],
        }}
        setupError={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "/Users/test/Obsidian/Second Brain" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /^Mount$/i }).closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /reveal existing mount/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /reveal existing mount/i }));
    expect(onRevealMount).toHaveBeenCalledWith("mount-1");
  });
});
