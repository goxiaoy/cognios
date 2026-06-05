import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceNoteTranscriptLines } from "./VoiceNoteRecordingPreview";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VoiceNoteTranscriptLines", () => {
  it("renders time and speaker metadata separately from transcript text", () => {
    render(
      <VoiceNoteTranscriptLines transcript="[02:13.521 - 02:21.521] Speaker 1: live line" />
    );

    const time = screen.getByText("02:13.521 - 02:21.521");
    const speaker = screen.getByText("Speaker 1");
    expect(speaker.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("live line")).toBeInTheDocument();
    expect(screen.queryByText(/Speaker 1: live line/)).not.toBeInTheDocument();
  });

  it("follows new transcript lines only while the scroll container is already at the bottom", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const { rerender } = render(
      <div data-testid="scroller">
        <VoiceNoteTranscriptLines followTail={true} transcript="[00:00.000] Speaker 1: first" />
      </div>
    );
    const scroller = screen.getByTestId("scroller");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 420 },
      scrollTop: { configurable: true, value: 320, writable: true },
    });
    fireEvent.scroll(scroller);

    rerender(
      <div data-testid="scroller">
        <VoiceNoteTranscriptLines
          followTail={true}
          transcript={"[00:00.000] Speaker 1: first\n[00:01.000] Speaker 1: second"}
        />
      </div>
    );
    expect(scroller.scrollTop).toBe(420);

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    rerender(
      <div data-testid="scroller">
        <VoiceNoteTranscriptLines
          followTail={true}
          transcript={
            "[00:00.000] Speaker 1: first\n[00:01.000] Speaker 1: second\n[00:02.000] Speaker 1: third"
          }
        />
      </div>
    );
    expect(scroller.scrollTop).toBe(100);
  });
});
