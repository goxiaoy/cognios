import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileAudio, Mic, RefreshCw, ShieldAlert, WandSparkles } from "lucide-react";

import {
  AUDIO_TRANSCRIPT_MODEL_ROLE,
  type CaptureCapability,
  type VoiceNote,
} from "../../../lib/contracts/voiceNote";
import type { ModelsStatus, SidecarEnvelope } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { VoiceNoteClient } from "../api/voiceNoteClient";

const EMPTY_CAPABILITY: CaptureCapability = {
  systemAudioRecording: false,
  automaticDetection: false,
  reason: "Voice note capture capability is loading.",
};

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

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const created = await client.create({});
      locallyCreatedNoteIds.current.add(created.voiceNote.noteId);
      setVoiceNotes((notes) => [created.voiceNote, ...notes]);
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
          <span>{creating ? "Creating" : "New voice note"}</span>
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
    value: role.state === "ready" ? "Ready" : role.state,
    detail: role.repo || "Model repo unknown.",
    tone: role.state === "ready" ? "ready" : "loading",
  };
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
