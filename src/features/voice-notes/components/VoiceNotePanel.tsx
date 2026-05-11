import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileAudio, Mic, RefreshCw, ShieldAlert, Square, WandSparkles } from "lucide-react";

import {
  AUDIO_TRANSCRIPT_MODEL_ROLE,
  type CaptureCapability,
  type VoiceNote,
} from "../../../lib/contracts/voiceNote";
import type {
  ModelRoleStatus,
  ModelsStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import { useOptionalExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import {
  type ModelDownloadStartResult,
  modelRolesAtOrAbovePriority,
  startModelDownloadsInPriorityOrder,
} from "../../search/modelDownloadPriority";
import type { SearchClient } from "../../search/types/search";
import type { VoiceNoteClient } from "../api/voiceNoteClient";

const EMPTY_CAPABILITY: CaptureCapability = {
  systemAudioRecording: false,
  automaticDetection: false,
  reason: "Voice note capture capability is loading.",
};
const ASR_POLL_INTERVAL_MS = 1_000;
const ASR_READY_TIMEOUT_MS = 30 * 60 * 1_000;

export type VoiceNoteRecorderFactory = (
  noteId: string,
  client: VoiceNoteClient
) => Promise<VoiceNoteRecording>;

interface VoiceNoteRecording {
  voiceNote: VoiceNote;
  startedAt: number;
  stop(): Promise<VoiceNote>;
}

export function VoiceNotePanel({
  client,
  searchClient,
  recorderFactory = createBrowserVoiceNoteRecorder,
}: {
  client: VoiceNoteClient;
  searchClient: SearchClient;
  recorderFactory?: VoiceNoteRecorderFactory;
}) {
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
  const [capture, setCapture] = useState<CaptureCapability>(EMPTY_CAPABILITY);
  const [models, setModels] = useState<SidecarEnvelope<ModelsStatus> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [activeRecording, setActiveRecording] = useState<{
    noteId: string;
    startedAt: number;
    elapsedMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const locallyCreatedNoteIds = useRef(new Set<string>());
  const asrDownloadRequested = useRef(false);
  const recordingRef = useRef<VoiceNoteRecording | null>(null);
  const explorerStore = useOptionalExplorerStoreContext();

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [nextNotes, nextCapture, nextModels] = await Promise.all([
        client.list(),
        client.captureCapability(),
        searchClient.modelsStatus(),
      ]);
      setVoiceNotes((currentNotes) =>
        mergeServerNotesWithLocalCreates(
          nextNotes,
          currentNotes,
          locallyCreatedNoteIds.current
        )
      );
      setCapture(nextCapture);
      setModels(nextModels);
      setStatusMessage(`Voice notes refreshed. ${nextNotes.length} notes.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [client, searchClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const asrDisplay = useMemo(() => describeAsrStatus(models), [models]);
  const browserCaptureAvailable = isBrowserAudioCaptureAvailable();

  const refreshModels = useCallback(async () => {
    const nextModels = await searchClient.modelsStatus();
    setModels(nextModels);
    return nextModels;
  }, [searchClient]);

  useEffect(() => {
    if (!shouldAutoStartAsrDownload(models, asrDownloadRequested.current)) return;
    let cancelled = false;
    asrDownloadRequested.current = true;
    setStatusMessage("Downloading Qwen ASR for voice notes.");
    void startAsrAndHigherPriorityDownloads(searchClient, models)
      .then(async (results) => {
        if (cancelled) return;
        throwIfAsrStartFailed(results);
        await refresh();
      })
      .catch((err) => {
        if (cancelled || isAlreadyDownloadingError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [models, refresh, searchClient]);

  const ensureAsrReady = useCallback(async () => {
    const deadline = Date.now() + ASR_READY_TIMEOUT_MS;
    let current = models ?? (await refreshModels());
    let kickedDownload = false;

    while (Date.now() < deadline) {
      const role = getAsrRole(current);
      if (role?.state === "ready") return;
      if (current.state !== "ready" || !current.data) {
        throw new Error(current.error ?? "Search sidecar is not ready.");
      }
      if (!role) {
        throw new Error("Qwen ASR model role is not configured in this sidecar.");
      }
      if (role.state === "error" && kickedDownload) {
        throw new Error(role.error ?? "Qwen ASR download failed.");
      }

      if (
        !kickedDownload &&
        role.state !== "downloading" &&
        role.state !== "verifying" &&
        role.state !== "queued"
      ) {
        kickedDownload = true;
        asrDownloadRequested.current = true;
        setStatusMessage("Preparing Qwen ASR before starting voice note.");
        throwIfAsrStartFailed(
          await startAsrAndHigherPriorityDownloads(searchClient, current)
        );
      } else {
        await delay(ASR_POLL_INTERVAL_MS);
      }

      current = await refreshModels();
    }

    throw new Error("Timed out waiting for Qwen ASR to finish downloading.");
  }, [models, refreshModels, searchClient]);

  useEffect(() => {
    if (!activeRecording) return;
    const timer = window.setInterval(() => {
      setActiveRecording((current) =>
        current
          ? {
              ...current,
              elapsedMs: Date.now() - current.startedAt,
            }
          : current
      );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [activeRecording?.noteId]);

  async function handleCreate() {
    if (activeRecording) {
      await handleStopRecording();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await ensureAsrReady();
      const created = await client.create({});
      locallyCreatedNoteIds.current.add(created.voiceNote.noteId);
      setVoiceNotes((notes) => [created.voiceNote, ...notes]);
      explorerStore?.applySnapshot(created.snapshot);
      const recording = await recorderFactory(created.voiceNote.noteId, client);
      recordingRef.current = recording;
      setVoiceNotes((notes) => upsertVoiceNote(notes, recording.voiceNote));
      setActiveRecording({
        noteId: created.voiceNote.noteId,
        startedAt: recording.startedAt,
        elapsedMs: 0,
      });
      setStatusMessage("Recording voice note.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleStopRecording() {
    const recording = recordingRef.current;
    if (!recording) return;
    setStopping(true);
    setError(null);
    try {
      const updated = await recording.stop();
      recordingRef.current = null;
      setActiveRecording(null);
      setVoiceNotes((notes) => upsertVoiceNote(notes, updated));
      setStatusMessage("Recording saved. Transcription pending.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  return (
    <section className="voice-note-page" aria-label="Voice notes">
      <header className="voice-note-hero">
        <div>
          <p className="eyebrow">Voice Notes</p>
          <h2>Meeting transcripts</h2>
          <p className="muted-copy">
            Manual audio recording is ready now. Automatic meeting detection and native system audio capture stay disabled until the capture adapter lands.
          </p>
        </div>
        <button
          className={`voice-note-primary${activeRecording ? " voice-note-primary--recording" : ""}`}
          disabled={activeRecording ? stopping : creating || loading || refreshing}
          onClick={handleCreate}
          type="button"
        >
          {activeRecording ? (
            <Square size={15} aria-hidden="true" />
          ) : (
            <Mic size={16} aria-hidden="true" />
          )}
          <span>
            {activeRecording
              ? stopping
                ? "Saving recording"
                : "Stop recording"
              : creating
                ? "Preparing ASR"
                : "New voice note"}
          </span>
        </button>
      </header>

      {activeRecording ? (
        <div className="voice-note-recording-bar" role="status" aria-live="polite">
          <span aria-hidden="true" />
          <strong>Recording</strong>
          <time>{formatElapsed(activeRecording.elapsedMs)}</time>
        </div>
      ) : null}

      <section className="voice-note-status-grid" aria-label="Voice note readiness">
        <StatusBlock
          icon={<FileAudio size={17} aria-hidden="true" />}
          label="Audio capture"
          value={browserCaptureAvailable ? "Available" : "Unsupported"}
          detail={
            browserCaptureAvailable
              ? "Manual recording uses the WebView audio capture adapter."
              : capture.reason
          }
          tone={browserCaptureAvailable ? "ready" : "blocked"}
        />
        <StatusBlock
          icon={<ShieldAlert size={17} aria-hidden="true" />}
          label="Meeting detection"
          value={capture.automaticDetection ? "Available" : "Manual only"}
          detail="Users can start a voice note manually from this section."
          tone={capture.automaticDetection ? "ready" : "blocked"}
        />
        <StatusBlock
          icon={<WandSparkles size={17} aria-hidden="true" />}
          label="Qwen3-ASR 0.6B"
          value={asrDisplay.value}
          detail={asrDisplay.detail}
          tone={asrDisplay.tone}
        />
      </section>

      <section className="voice-note-list-section">
        <span className="sr-only" role="status" aria-live="polite">
          {statusMessage}
        </span>
        <div className="voice-note-section-head">
          <div>
            <h3>Recent voice notes</h3>
            <span>{voiceNotes.length.toLocaleString()} notes</span>
          </div>
          <button
            className="icon-button"
            disabled={refreshing}
            onClick={refresh}
            type="button"
            aria-label="Refresh voice notes"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>

        {error ? <p className="voice-note-error" role="alert">{error}</p> : null}
        {loading ? (
          <p className="muted-copy" role="status" aria-live="polite">
            Loading voice notes.
          </p>
        ) : null}
        {!loading && voiceNotes.length === 0 ? (
          <div className="voice-note-empty">
            <FileAudio size={22} aria-hidden="true" />
            <p>No voice notes yet.</p>
          </div>
        ) : null}
        {voiceNotes.length > 0 ? (
          <ul className="voice-note-list">
            {voiceNotes.map((voiceNote) => (
              <li className="voice-note-row" key={voiceNote.noteId}>
                <div>
                  <strong>Untitled Voice Note</strong>
                  <span>{voiceNote.transcriptionStatus}</span>
                </div>
                <div className="voice-note-row-meta">
                  <StatusPill>{voiceNote.captureStatus}</StatusPill>
                  <StatusPill>{voiceNote.summaryStatus}</StatusPill>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}

function StatusBlock({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "blocked" | "loading";
}) {
  return (
    <article className={`voice-note-status voice-note-status--${tone}`}>
      <div className="voice-note-status-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function StatusPill({ children }: { children: ReactNode }) {
  return <span className="voice-note-pill">{children}</span>;
}

function describeAsrStatus(models: SidecarEnvelope<ModelsStatus> | null): {
  value: string;
  detail: string;
  tone: "ready" | "blocked" | "loading";
} {
  if (!models) {
    return {
      value: "Checking",
      detail: "Waiting for sidecar model status.",
      tone: "loading",
    };
  }
  if (models.state !== "ready" || !models.data) {
    return {
      value: "Unavailable",
      detail: models.error ?? "Search sidecar is not ready.",
      tone: "blocked",
    };
  }

  const role = models.data.roles[AUDIO_TRANSCRIPT_MODEL_ROLE];
  if (!role) {
    return {
      value: "Not configured",
      detail: "The ASR role is reserved for Qwen3-ASR 0.6B but no manifest entry is installed yet.",
      tone: "blocked",
    };
  }

  return {
    value: role.state === "ready" ? "Ready" : titleCaseState(role.state),
    detail:
      role.state === "missing"
        ? "Download starts automatically before recording."
        : role.repo || "Model repo unknown.",
    tone: role.state === "ready" ? "ready" : "loading",
  };
}

function getAsrRole(
  models: SidecarEnvelope<ModelsStatus> | null
): ModelRoleStatus | null {
  if (models?.state !== "ready" || !models.data) return null;
  return models.data.roles[AUDIO_TRANSCRIPT_MODEL_ROLE] ?? null;
}

function shouldAutoStartAsrDownload(
  models: SidecarEnvelope<ModelsStatus> | null,
  alreadyRequested: boolean
): boolean {
  if (alreadyRequested) return false;
  const role = getAsrRole(models);
  return role?.state === "missing";
}

function startAsrAndHigherPriorityDownloads(
  client: SearchClient,
  models: SidecarEnvelope<ModelsStatus> | null
): Promise<ModelDownloadStartResult[]> {
  if (models?.state !== "ready" || !models.data) return Promise.resolve([]);
  return startModelDownloadsInPriorityOrder(
    client,
    modelRolesAtOrAbovePriority(models.data.roles, AUDIO_TRANSCRIPT_MODEL_ROLE)
  );
}

function throwIfAsrStartFailed(results: ModelDownloadStartResult[]): void {
  const failedAsr = results.find(
    (result) =>
      result.role === AUDIO_TRANSCRIPT_MODEL_ROLE &&
      result.status === "rejected" &&
      !isAlreadyDownloadingError(result.reason)
  );
  if (!failedAsr || failedAsr.status !== "rejected") return;
  throw failedAsr.reason instanceof Error
    ? failedAsr.reason
    : new Error(String(failedAsr.reason));
}

function isAlreadyDownloadingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("already downloading");
}

function titleCaseState(state: string): string {
  return state.slice(0, 1).toUpperCase() + state.slice(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function upsertVoiceNote(notes: VoiceNote[], next: VoiceNote): VoiceNote[] {
  const existingIndex = notes.findIndex((note) => note.noteId === next.noteId);
  if (existingIndex === -1) return [next, ...notes];
  return notes.map((note, index) => (index === existingIndex ? next : note));
}

function mergeServerNotesWithLocalCreates(
  serverNotes: VoiceNote[],
  currentNotes: VoiceNote[],
  localIds: Set<string>
): VoiceNote[] {
  const serverIds = new Set(serverNotes.map((note) => note.noteId));
  for (const id of serverIds) {
    localIds.delete(id);
  }

  const pendingLocalNotes = currentNotes.filter((note) => localIds.has(note.noteId));
  return [...pendingLocalNotes, ...serverNotes];
}

async function createBrowserVoiceNoteRecorder(
  noteId: string,
  client: VoiceNoteClient
): Promise<VoiceNoteRecording> {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("Audio recording is not available in this WebView.");
  }
  const stream = await requestVoiceNoteAudioStream();
  const mimeType = preferredAudioMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(
      stream,
      mimeType
        ? {
            mimeType,
          }
        : undefined
    );
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }
  const startedAt = Date.now();
  let writeQueue = Promise.resolve();
  let writeError: unknown = null;

  let started: VoiceNote;
  try {
    started = await client.beginAudioCapture({
      noteId,
      mimeType: recorder.mimeType || mimeType || null,
      fileExtension: audioExtensionForMimeType(recorder.mimeType || mimeType),
    });
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0) return;
    writeQueue = writeQueue
      .then(async () => {
        const bytes = Array.from(new Uint8Array(await event.data.arrayBuffer()));
        await client.appendAudioChunk({ noteId, bytes });
      })
      .catch((err) => {
        writeError = err;
        throw err;
      });
    void writeQueue.catch(() => {});
  });

  try {
    recorder.start(1_000);
  } catch (err) {
    stopMediaStream(stream);
    throw err;
  }

  return {
    voiceNote: started,
    startedAt,
    async stop() {
      try {
        if (recorder.state !== "inactive") {
          const stopped = new Promise<void>((resolve, reject) => {
            recorder.addEventListener("stop", () => resolve(), { once: true });
            recorder.addEventListener(
              "error",
              (event) => reject(mediaRecorderError(event)),
              { once: true }
            );
          });
          recorder.requestData();
          recorder.stop();
          await stopped;
        }
        await writeQueue.catch(() => {});
        if (writeError) {
          throw writeError instanceof Error
            ? writeError
            : new Error(String(writeError));
        }
        return await client.finishAudioCapture({
          noteId,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        stopMediaStream(stream);
      }
    },
  };
}

async function requestVoiceNoteAudioStream(): Promise<MediaStream> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) {
    throw new Error("Audio capture is not available in this environment.");
  }

  if (mediaDevices.getDisplayMedia) {
    try {
      const displayStream = await mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = displayStream.getAudioTracks();
      displayStream.getVideoTracks().forEach((track) => track.stop());
      if (audioTracks.length > 0) {
        return new MediaStream(audioTracks);
      }
      stopMediaStream(displayStream);
    } catch {
      // Fall back to microphone capture below.
    }
  }

  if (!mediaDevices.getUserMedia) {
    throw new Error("Audio capture is not available in this environment.");
  }
  return mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  });
}

function isBrowserAudioCaptureAvailable(): boolean {
  if (typeof MediaRecorder === "undefined") return false;
  const mediaDevices = navigator.mediaDevices;
  return Boolean(mediaDevices?.getUserMedia || mediaDevices?.getDisplayMedia);
}

function preferredAudioMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function audioExtensionForMimeType(mimeType?: string): string {
  const baseType = (mimeType || "").split(";")[0];
  if (baseType === "audio/mp4" || baseType === "audio/aac") return "m4a";
  if (baseType === "audio/ogg") return "ogg";
  if (baseType === "audio/wav" || baseType === "audio/wave") return "wav";
  return "webm";
}

function mediaRecorderError(event: Event): Error {
  const maybeError = event as Event & { error?: { message?: string } };
  return new Error(maybeError.error?.message ?? "Audio recording failed.");
}

function stopMediaStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
