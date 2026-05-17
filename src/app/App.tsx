import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelRoleStatus,
  ModelsStatus,
  SidecarEnvelope,
} from "../lib/contracts/search";
import {
  AUDIO_TRANSCRIPT_MODEL_ROLE,
  type VoiceNote,
} from "../lib/contracts/voiceNote";
import { chatClient } from "../features/chat/api/chatClient";
import { ChatLayout } from "../features/chat/components/ChatLayout";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import {
  ExplorerStoreProvider,
  useExplorerStoreContext,
} from "../features/explorer/store/ExplorerStoreContext";
import { HomeDashboard } from "../features/home/components/HomeDashboard";
import { searchClient } from "../features/search/api/searchClient";
import { SearchPalette } from "../features/search/components/SearchPalette";
import {
  modelRolesAtOrAbovePriority,
  startModelDownloadsInPriorityOrder,
  type ModelDownloadStartResult,
} from "../features/search/modelDownloadPriority";
import { SettingsLayout } from "../features/settings/components/SettingsLayout";
import { voiceNoteClient } from "../features/voice-notes/api/voiceNoteClient";
import type {
  VoiceNotePreviewSession,
  VoiceNoteRecordingPhase,
} from "../features/voice-notes/components/VoiceNoteRecordingPreview";
import {
  createVoiceNoteRecorder,
  type VoiceNoteRecording,
} from "../features/voice-notes/recording";
import { AppSection, AppSidebar } from "./AppSidebar";
import { useAutoModelDownload } from "./hooks/useAutoModelDownload";

const SECTION_LABELS: Record<AppSection, string> = {
  home: "Home",
  chat: "Chat",
  explorer: "Explorer",
  memory: "Memory Timeline",
  settings: "Settings",
};

const ASR_POLL_INTERVAL_MS = 1_000;
const ASR_READY_TIMEOUT_MS = 30 * 60 * 1_000;

interface ActiveVoiceNote {
  note: VoiceNote;
  phase: VoiceNoteRecordingPhase;
  elapsedMs: number;
  elapsedBaseMs: number;
  resumedAt: number | null;
  error: string | null;
}

export function App() {
  return (
    <ExplorerStoreProvider client={explorerClient}>
      <AppShell />
    </ExplorerStoreProvider>
  );
}

/**
 * Inner shell. Lives below ``ExplorerStoreProvider`` so any future
 * global keyboard binding can read store state without prop drilling.
 */
function AppShell() {
  const explorerStore = useExplorerStoreContext();
  const [activeSection, setActiveSection] = useState<AppSection>("home");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [voiceNoteStarting, setVoiceNoteStarting] = useState(false);
  const [voiceNoteFocusRequest, setVoiceNoteFocusRequest] = useState<{
    nodeId: string;
    serial: number;
  } | null>(null);
  const [activeVoiceNote, setActiveVoiceNote] = useState<ActiveVoiceNote | null>(null);
  const voiceNoteRecordingRef = useRef<VoiceNoteRecording | null>(null);
  const voiceNoteFocusSerial = useRef(0);
  const sectionLabel = SECTION_LABELS[activeSection];

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // First-run model bootstrap: silently kick off downloads for enabled
  // local features' models if they're not on disk yet. The DownloadDock
  // in the sidebar surfaces progress.
  useAutoModelDownload(searchClient);

  // Global keyboard shortcut. Cmd/Ctrl+K toggles the palette; the
  // palette is the only search surface — filter chips, sort, and
  // cursor pagination all live inside it. Esc-to-close is owned by
  // the palette itself.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCmdOrCtrl) return;
      if (event.key.toLowerCase() !== "k") return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // When activating a search result we want the user to land on the
  // Explorer section so the activation (note editor, markdown preview,
  // image viewer) is visible.
  const focusExplorer = useCallback(() => setActiveSection("explorer"), []);

  const focusExplorerNode = useCallback((nodeId: string) => {
    voiceNoteFocusSerial.current += 1;
    setVoiceNoteFocusRequest({
      nodeId,
      serial: voiceNoteFocusSerial.current,
    });
    setActiveSection("explorer");
  }, []);

  const handleVoiceNoteFocusHandled = useCallback(() => {
    setVoiceNoteFocusRequest(null);
  }, []);

  const startVoiceNoteRecording = useCallback(async () => {
    if (activeVoiceNote && !isTerminalVoiceNotePhase(activeVoiceNote.phase)) {
      focusExplorerNode(activeVoiceNote.note.noteId);
      return;
    }

    setVoiceNoteStarting(true);
    try {
      await ensureAsrReadyForVoiceNote(searchClient);
      const created = await voiceNoteClient.create({});
      explorerStore.applySnapshot(created.snapshot);
      focusExplorerNode(created.voiceNote.noteId);
      setActiveVoiceNote({
        note: created.voiceNote,
        phase: "preparing",
        elapsedMs: 0,
        elapsedBaseMs: 0,
        resumedAt: null,
        error: null,
      });

      const recording = await createVoiceNoteRecorder(
        created.voiceNote.noteId,
        voiceNoteClient
      );
      voiceNoteRecordingRef.current = recording;
      setActiveVoiceNote({
        note: recording.voiceNote,
        phase: "recording",
        elapsedMs: 0,
        elapsedBaseMs: 0,
        resumedAt: Date.now(),
        error: null,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setActiveVoiceNote((current) =>
        current
          ? {
              ...current,
              phase: "failed",
              error: message,
            }
          : null
      );
    } finally {
      setVoiceNoteStarting(false);
    }
  }, [activeVoiceNote, explorerStore, focusExplorerNode]);

  const stopVoiceNoteRecording = useCallback(async () => {
    const recording = voiceNoteRecordingRef.current;
    const noteId = activeVoiceNote?.note.noteId;
    if (!recording || !noteId) return;
    setActiveVoiceNote((current) =>
      current
        ? {
            ...current,
            phase: "stopping",
          }
        : current
    );
    try {
      const updated = await recording.stop();
      voiceNoteRecordingRef.current = null;
      setActiveVoiceNote((current) =>
        current
          ? {
              ...current,
              note: updated,
              phase: "transcribing",
              resumedAt: null,
            }
          : current
      );
      void monitorVoiceNoteCompletion(noteId, (next) => {
        setActiveVoiceNote((current) =>
          current?.note.noteId === noteId
            ? {
                ...current,
                note: next,
                phase: next.status === "failed" ? "failed" : "complete",
                error: next.status === "failed" ? "Voice note transcription failed." : null,
              }
            : current
        );
        void explorerStore.refresh().catch(() => {});
      });
    } catch (cause) {
      setActiveVoiceNote((current) =>
        current
          ? {
              ...current,
              phase: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            }
          : current
      );
    }
  }, [activeVoiceNote?.note.noteId, explorerStore]);

  const toggleVoiceNotePause = useCallback(async () => {
    const recording = voiceNoteRecordingRef.current;
    if (!recording) return;
    const now = Date.now();
    const current = activeVoiceNote;
    if (!current) return;
    try {
      if (current.phase === "recording") {
        await recording.pause();
        const elapsed =
          current.elapsedBaseMs +
          (current.resumedAt ? now - current.resumedAt : 0);
        setActiveVoiceNote({
          ...current,
          phase: "paused",
          elapsedMs: elapsed,
          elapsedBaseMs: elapsed,
          resumedAt: null,
        });
      } else if (current.phase === "paused") {
        await recording.resume();
        setActiveVoiceNote({
          ...current,
          phase: "recording",
          resumedAt: Date.now(),
        });
      }
    } catch (cause) {
      setActiveVoiceNote({
        ...current,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [activeVoiceNote]);

  useEffect(() => {
    if (activeVoiceNote?.phase !== "recording" || !activeVoiceNote.resumedAt) return;
    const timer = window.setInterval(() => {
      setActiveVoiceNote((current) => {
        if (current?.phase !== "recording" || !current.resumedAt) return current;
        return {
          ...current,
          elapsedMs: current.elapsedBaseMs + Date.now() - current.resumedAt,
        };
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [activeVoiceNote?.phase, activeVoiceNote?.resumedAt]);

  const voiceNotePreviewSession = useMemo<VoiceNotePreviewSession | null>(() => {
    if (!activeVoiceNote) return null;
    return {
      note: activeVoiceNote.note,
      elapsedMs: activeVoiceNote.elapsedMs,
      phase: activeVoiceNote.phase,
      error: activeVoiceNote.error,
      onTogglePause: () => {
        void toggleVoiceNotePause();
      },
      onStop: () => {
        void stopVoiceNoteRecording();
      },
    };
  }, [activeVoiceNote, stopVoiceNoteRecording, toggleVoiceNotePause]);

  return (
    <main className="app-shell">
      <div className="app-titlebar" data-tauri-drag-region />
      <AppSidebar
        activeSection={activeSection}
        isVoiceNoteStarting={voiceNoteStarting}
        onNewVoiceNote={() => {
          void startVoiceNoteRecording();
        }}
        onSelect={setActiveSection}
        onOpenSearch={openPalette}
      />

      <div className="app-content">
        <header className="app-content-header">
          <h1 className="app-content-title">{sectionLabel}</h1>
        </header>

        <div className="app-content-body">
          <div className={`app-panel${activeSection === "explorer" ? " is-active" : ""}`}>
            <ExplorerLayout
              active={activeSection === "explorer"}
              client={explorerClient}
              focusNodeRequest={voiceNoteFocusRequest}
              onFocusNodeRequestHandled={handleVoiceNoteFocusHandled}
              voiceNoteSession={voiceNotePreviewSession}
            />
          </div>

          {activeSection === "settings" ? (
            <section className="settings-page-panel">
              <SettingsLayout client={searchClient} />
            </section>
          ) : null}

          {activeSection === "home" ? (
            <section className="home-page-panel">
              <HomeDashboard client={searchClient} />
            </section>
          ) : null}

          <div className={`app-panel${activeSection === "chat" ? " is-active" : ""}`}>
            <section className="chat-page-panel" aria-hidden={activeSection !== "chat"}>
              <ChatLayout
                client={chatClient}
                searchClient={searchClient}
                visible={activeSection === "chat"}
                onActivateSource={focusExplorer}
              />
            </section>
          </div>

          {activeSection !== "explorer" && activeSection !== "settings" && activeSection !== "chat" && activeSection !== "home" ? (
            <section className="placeholder-panel">
              <p className="eyebrow">{sectionLabel}</p>
              <p className="muted-copy">
                This section is stubbed in Milestone 2 so the application shell and navigation contract can land before feature implementation.
              </p>
            </section>
          ) : null}
        </div>
      </div>

      {paletteOpen ? (
        <SearchPalette
          client={searchClient}
          onClose={closePalette}
          onActivate={focusExplorer}
        />
      ) : null}
    </main>
  );
}

async function ensureAsrReadyForVoiceNote(client: typeof searchClient): Promise<void> {
  const deadline = Date.now() + ASR_READY_TIMEOUT_MS;
  let current = await client.modelsStatus();
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
      throwIfAsrStartFailed(
        await startModelDownloadsInPriorityOrder(
          client,
          modelRolesAtOrAbovePriority(current.data.roles, AUDIO_TRANSCRIPT_MODEL_ROLE)
        )
      );
    } else {
      await delay(ASR_POLL_INTERVAL_MS);
    }

    current = await client.modelsStatus();
  }

  throw new Error("Timed out waiting for Qwen ASR to finish downloading.");
}

function getAsrRole(
  models: SidecarEnvelope<ModelsStatus> | null
): ModelRoleStatus | null {
  if (models?.state !== "ready" || !models.data) return null;
  return models.data.roles[AUDIO_TRANSCRIPT_MODEL_ROLE] ?? null;
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

function isTerminalVoiceNotePhase(phase: VoiceNoteRecordingPhase): boolean {
  return phase === "complete" || phase === "failed";
}

async function monitorVoiceNoteCompletion(
  noteId: string,
  onDone: (voiceNote: VoiceNote) => void
): Promise<void> {
  const deadline = Date.now() + ASR_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(2_000);
    const next = await voiceNoteClient.get(noteId);
    if (!next) continue;
    if (
      next.status === "completed" ||
      next.status === "failed" ||
      next.transcriptionStatus === "failed" ||
      next.transcriptionStatus === "unavailable"
    ) {
      onDone(next);
      return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
