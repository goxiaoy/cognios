import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileAudio, Mic, RefreshCw, ShieldAlert, WandSparkles } from "lucide-react";

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
import type { SearchClient } from "../../search/types/search";
import type { VoiceNoteClient } from "../api/voiceNoteClient";

const EMPTY_CAPABILITY: CaptureCapability = {
  systemAudioRecording: false,
  automaticDetection: false,
  reason: "Voice note capture capability is loading.",
};
const ASR_POLL_INTERVAL_MS = 1_000;
const ASR_READY_TIMEOUT_MS = 30 * 60 * 1_000;

export function VoiceNotePanel({
  client,
  searchClient,
}: {
  client: VoiceNoteClient;
  searchClient: SearchClient;
}) {
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
  const [capture, setCapture] = useState<CaptureCapability>(EMPTY_CAPABILITY);
  const [models, setModels] = useState<SidecarEnvelope<ModelsStatus> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const locallyCreatedNoteIds = useRef(new Set<string>());
  const asrDownloadRequested = useRef(false);
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
    void searchClient
      .startModelDownload({ role: AUDIO_TRANSCRIPT_MODEL_ROLE })
      .then(async () => {
        if (cancelled) return;
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
        try {
          await searchClient.startModelDownload({ role: AUDIO_TRANSCRIPT_MODEL_ROLE });
        } catch (err) {
          if (!isAlreadyDownloadingError(err)) {
            throw err;
          }
        }
      } else {
        await delay(ASR_POLL_INTERVAL_MS);
      }

      current = await refreshModels();
    }

    throw new Error("Timed out waiting for Qwen ASR to finish downloading.");
  }, [models, refreshModels, searchClient]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      await ensureAsrReady();
      const created = await client.create({});
      locallyCreatedNoteIds.current.add(created.voiceNote.noteId);
      setVoiceNotes((notes) => [created.voiceNote, ...notes]);
      explorerStore?.applySnapshot(created.snapshot);
      setStatusMessage("Voice note created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="voice-note-page" aria-label="Voice notes">
      <header className="voice-note-hero">
        <div>
          <p className="eyebrow">Voice Notes</p>
          <h2>Meeting transcripts</h2>
          <p className="muted-copy">
            Manual notes are ready now. Automatic meeting detection and system audio capture stay disabled until the native capture adapter lands.
          </p>
        </div>
        <button
          className="voice-note-primary"
          disabled={creating || loading || refreshing}
          onClick={handleCreate}
          type="button"
        >
          <Mic size={16} aria-hidden="true" />
          <span>{creating ? "Preparing ASR" : "New voice note"}</span>
        </button>
      </header>

      <section className="voice-note-status-grid" aria-label="Voice note readiness">
        <StatusBlock
          icon={<FileAudio size={17} aria-hidden="true" />}
          label="System audio"
          value={capture.systemAudioRecording ? "Available" : "Unsupported"}
          detail={capture.reason}
          tone={capture.systemAudioRecording ? "ready" : "blocked"}
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
