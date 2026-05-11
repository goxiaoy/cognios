import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceNote } from "../../../lib/contracts/voiceNote";
import { makeStubSearchClient } from "../../search/types/test-helpers";
import type { VoiceNoteClient } from "../api/voiceNoteClient";
import { VoiceNotePanel } from "./VoiceNotePanel";

function makeVoiceNote(overrides: Partial<VoiceNote> = {}): VoiceNote {
  return {
    noteId: "voice-1",
    status: "pending_audio",
    captureStatus: "unsupported",
    transcriptionStatus: "pending",
    summaryStatus: "unavailable",
    sourceAudioPresent: false,
    sourceAudioPath: null,
    sourceAudioDeletedAt: null,
    transcriptUpdatedAt: null,
    speakerLabels: {},
    createdAt: "2026-05-11 10:00:00",
    updatedAt: "2026-05-11 10:00:00",
    ...overrides,
  };
}

function makeClient(overrides: Partial<VoiceNoteClient> = {}): VoiceNoteClient {
  return {
    captureCapability: vi.fn().mockResolvedValue({
      systemAudioRecording: false,
      automaticDetection: false,
      reason: "System audio capture and meeting detection are not wired in this build.",
    }),
    create: vi.fn().mockResolvedValue({
      voiceNote: makeVoiceNote({ noteId: "created-1" }),
      snapshot: { roots: [] },
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    completeTranscript: vi.fn(),
    renameSpeaker: vi.fn(),
    deleteSourceAudio: vi.fn(),
    ...overrides,
  };
}

describe("VoiceNotePanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders honest unsupported capture and missing ASR readiness states", async () => {
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue({ state: "ready", data: { roles: {} } }),
        })}
      />
    );

    expect(await screen.findByText("Unsupported")).toBeInTheDocument();
    expect(screen.getByText("Manual only")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("creates a manual voice note from the primary action", async () => {
    const client = makeClient();
    render(
      <VoiceNotePanel
        client={client}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue({ state: "ready", data: { roles: {} } }),
        })}
      />
    );

    await screen.findByText("No voice notes yet.");
    fireEvent.click(screen.getByRole("button", { name: /New voice note/i }));

    await waitFor(() => {
      expect(client.create).toHaveBeenCalledWith({});
    });
    expect(await screen.findByText("Untitled Voice Note")).toBeInTheDocument();
    expect(screen.getByText("Voice note created.")).toBeInTheDocument();
  });

  it("keeps locally created notes visible across stale refresh results", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        voiceNote: makeVoiceNote({ noteId: "created-1" }),
        snapshot: { roots: [] },
      }),
    });
    render(
      <VoiceNotePanel
        client={client}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue({ state: "ready", data: { roles: {} } }),
        })}
      />
    );

    await screen.findByText("No voice notes yet.");
    fireEvent.click(screen.getByRole("button", { name: /New voice note/i }));
    expect(await screen.findByText("Untitled Voice Note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh voice notes/i }));

    await waitFor(() => {
      expect(client.list).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Untitled Voice Note")).toBeInTheDocument();
  });

  it("shows ASR ready when the audio transcript role is ready", async () => {
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue({
            state: "ready",
            data: {
              roles: {
                "audio-transcript": {
                  role: "audio-transcript",
                  state: "ready",
                  repo: "Qwen/Qwen3-ASR-0.6B",
                },
              },
            },
          }),
        })}
      />
    );

    expect(await screen.findByText("Qwen3-ASR 0.6B")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Qwen/Qwen3-ASR-0.6B")).toBeInTheDocument();
  });

  it("shows non-ready ASR role states when the role is present", async () => {
    render(
      <VoiceNotePanel
        client={makeClient()}
        searchClient={makeStubSearchClient({
          modelsStatus: vi.fn().mockResolvedValue({
            state: "ready",
            data: {
              roles: {
                "audio-transcript": {
                  role: "audio-transcript",
                  state: "downloading",
                  repo: "Qwen/Qwen3-ASR-0.6B",
                },
              },
            },
          }),
        })}
      />
    );

    expect(await screen.findByText("downloading")).toBeInTheDocument();
    expect(screen.getByText("Qwen/Qwen3-ASR-0.6B")).toBeInTheDocument();
  });
});
