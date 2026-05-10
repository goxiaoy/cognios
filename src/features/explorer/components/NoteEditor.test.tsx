import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExplorerClient } from "../types/explorer";
import { NoteEditor } from "./NoteEditor";

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
    reindexNode: vi.fn().mockResolvedValue({ enqueued: 0 }),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn().mockResolvedValue(""),
    saveNoteContent: vi.fn().mockResolvedValue(undefined),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
    ...overrides,
  };
}

describe("NoteEditor", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens notes in visual mode and can switch to raw markdown", async () => {
    const client = makeClient({
      getNoteContent: vi.fn().mockResolvedValue("# Timeline\n\n- **Cost**"),
    });

    const { container } = render(
      <NoteEditor
        client={client}
        flushError={null}
        initialTitle="事故复盘"
        nodeId="note-1"
        onTitleChange={vi.fn()}
      />
    );

    expect(await screen.findByRole("heading", { name: "Timeline", level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText("Visual markdown editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));

    await waitFor(() => {
      expect(container.querySelector(".cm-content")?.textContent).toContain("# Timeline");
    });
  });

  it("serializes visual edits back to markdown for autosave", async () => {
    const saveNoteContent = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      getNoteContent: vi.fn().mockResolvedValue(""),
      saveNoteContent,
    });

    render(
      <NoteEditor
        client={client}
        flushError={null}
        initialTitle="事故复盘"
        nodeId="note-1"
        onTitleChange={vi.fn()}
      />
    );

    const editor = await screen.findByLabelText("Visual markdown editor");
    vi.useFakeTimers();
    editor.innerHTML = "<h2>Edited</h2><p><strong>Done</strong></p><ul><li>Cost</li></ul>";
    fireEvent.input(editor);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(saveNoteContent).toHaveBeenCalledWith(
      "note-1",
      "## Edited\n\n**Done**\n\n- Cost"
    );
  });
});
