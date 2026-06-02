import {
  type AnchorHTMLAttributes,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  CircleAlert,
  File,
  FileText,
  Folder,
  Globe,
  HardDrive,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react";

import type {
  ChatContextNode,
  ChatMessage,
  ChatMessageRole,
  ChatModelsResponse,
  ChatSession,
  ChatSessionDetail,
  ChatModel,
  ChatSessionMemoryEventPayload,
  ChatTurnResponse,
  ChatTurnStreamPayload,
} from "../../../lib/contracts/chat";
import { AppSelect } from "../../../components/FormControls";
import type { SearchSettings } from "../../../lib/contracts/search";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import { MarkdownRenderer } from "../../explorer/components/MarkdownRenderer";
import { useOptionalExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import { SearchPalette, type SearchPaletteSelection } from "../../search/components/SearchPalette";
import type { SearchClient } from "../../search/types/search";
import type { ChatClient } from "../api/chatClient";
import {
  CHAT_PROVIDER_PRESETS,
  ChatProviderSetup,
  DEFAULT_CHAT_PROVIDER_ID,
} from "./ChatProviderSetup";

const CONTEXT_CONTENT_LIMIT = 8_000;
const CHAT_TURN_EVENT = "chat/turn";
const CHAT_MEMORY_EVENT = "chat/session-memory";
const chatProviderPresets = CHAT_PROVIDER_PRESETS;

interface OptimisticUserMessage {
  id: string;
  sessionId: string;
  body: string;
  contextNodes: ChatContextNode[];
  persistedBodyCountAtCreation: number;
}

interface ChatCitation {
  marker: string;
  label: string | null;
  nodeId: string | null;
  citation: string | null;
  title: string | null;
  sourceKind: string | null;
  path: string | null;
}

interface ChatToolEvent {
  toolName: string;
  status: string;
  summary: string;
  nodeId: string | null;
  resultCount: number | null;
}

export function ChatLayout({
  client,
  searchClient,
  visible = true,
  onActivateSource,
  workspaceIsEmpty = false,
}: {
  client: ChatClient;
  searchClient: SearchClient;
  visible?: boolean;
  onActivateSource?: () => void;
  workspaceIsEmpty?: boolean;
}) {
  const explorerStore = useOptionalExplorerStoreContext();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<ChatSessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [turn, setTurn] = useState<ChatTurnResponse | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<OptimisticUserMessage[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextNodes, setContextNodes] = useState<ChatContextNode[]>([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryBody, setMemoryBody] = useState("");
  const [memoryRevision, setMemoryRevision] = useState<number | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryExporting, setMemoryExporting] = useState(false);
  const [memoryExportedNoteId, setMemoryExportedNoteId] = useState<string | null>(null);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsStatus, setModelsStatus] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [setupProviderId, setSetupProviderId] = useState(DEFAULT_CHAT_PROVIDER_ID);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeTurnEventIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const memoryOpenRef = useRef(false);
  const memoryButtonRef = useRef<HTMLButtonElement | null>(null);
  const memoryPanelRef = useRef<HTMLElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const initializedRef = useRef(false);
  const pendingComposerFocusRef = useRef(false);

  useEffect(() => {
    if (!visible || initializedRef.current) return;
    initializedRef.current = true;
    void refreshSessions();
    void refreshModels();
    void refreshProviderSettings();
  }, [visible]);

  useEffect(() => {
    if (visible) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<ChatTurnStreamPayload>(CHAT_TURN_EVENT, (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.turnEventId !== activeTurnEventIdRef.current) return;
      const streamEvent = payload.event;
      if (streamEvent.event === "metadata") {
        setTurn((current) => ({
          state: "ready",
          clusters: streamEvent.clusters ?? current?.clusters ?? [],
          answer: current?.answer ?? "",
          citations: streamEvent.citations ?? current?.citations ?? [],
          warnings: streamEvent.warnings ?? current?.warnings ?? [],
          toolEvents: streamEvent.toolEvents ?? current?.toolEvents ?? [],
          provider: current?.provider,
        }));
        return;
      }
      if (streamEvent.event === "delta" && streamEvent.delta) {
        setTurn((current) => ({
          state: current?.state ?? "ready",
          clusters: current?.clusters ?? [],
          answer: `${current?.answer ?? ""}${streamEvent.delta}`,
          citations: current?.citations ?? [],
          warnings: current?.warnings ?? [],
          toolEvents: current?.toolEvents ?? [],
          provider: current?.provider,
        }));
        return;
      }
      const streamedToolEvents = streamEvent.toolEvents ?? [];
      if (streamEvent.event === "tool" && streamedToolEvents.length > 0) {
        setTurn((current) => ({
          state: current?.state ?? "ready",
          clusters: current?.clusters ?? [],
          answer: current?.answer ?? "",
          citations: current?.citations ?? [],
          warnings: current?.warnings ?? [],
          toolEvents: [...(current?.toolEvents ?? []), ...streamedToolEvents],
          provider: current?.provider,
        }));
        return;
      }
      if (streamEvent.event === "final") {
        if (streamEvent.turn) {
          setTurn(streamEvent.turn);
        }
        if (streamEvent.error) {
          setError(streamEvent.error);
        }
      }
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = active?.session.id ?? null;
  }, [active?.session.id]);

  useEffect(() => {
    memoryOpenRef.current = memoryOpen;
  }, [memoryOpen]);

  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<ChatSessionMemoryEventPayload>(CHAT_MEMORY_EVENT, (event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.sessionId !== activeSessionIdRef.current) return;
      void refreshSessions(payload.sessionId);
      if (memoryOpenRef.current) {
        void loadMemoryBody(payload.sessionId);
      }
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!memoryOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeMemoryPanel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [memoryOpen]);

  useEffect(() => {
    if (!sessionMenu) return;
    function close() {
      setSessionMenu(null);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sessionMenu]);

  useEffect(() => {
    if (!sessionMenu) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSessionMenu(null);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [sessionMenu]);

  async function refreshModels() {
    setModelsLoading(true);
    try {
      const result = await client.getModels();
      const data = unwrapEnvelope(result.models);
      if (!data || data.state !== "ready") {
        setModels([]);
        setSelectedModel("");
        setModelsStatus(chatModelsStatusMessage(data, result.models.error));
        return;
      }
      const sortedModels = [...data.models].sort((left, right) => {
        if ((left.supportsAgentic === false) !== (right.supportsAgentic === false)) {
          return left.supportsAgentic === false ? 1 : -1;
        }
        return left.name.localeCompare(right.name);
      });
      setModels(sortedModels);
      setSelectedModel((current) => {
        if (sortedModels.some((model) => model.id === current && model.supportsAgentic !== false)) {
          return current;
        }
        return sortedModels.find((model) => model.supportsAgentic !== false)?.id ?? "";
      });
      setModelsStatus(null);
    } catch {
      setModels([]);
      setSelectedModel("");
      setModelsStatus("Chat provider unavailable.");
    } finally {
      setModelsLoading(false);
    }
  }

  async function refreshProviderSettings() {
    setSettingsLoading(true);
    try {
      const env = await searchClient.settings();
      if (env.state === "ready" && env.data) {
        applyProviderSettings(env.data);
        return;
      }
      try {
        const fallback = await searchClient.readSettingsFallback();
        applyProviderSettings(fallback);
        setSettingsError(env.error ?? "Provider settings loaded from disk.");
      } catch {
        setSettings(null);
        setSettingsError(env.error ?? "Provider settings unavailable.");
      }
    } catch (err) {
      try {
        const fallback = await searchClient.readSettingsFallback();
        applyProviderSettings(fallback);
        setSettingsError("Provider settings loaded from disk.");
      } catch {
        setSettings(null);
        setSettingsError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSettingsLoading(false);
    }
  }

  function applyProviderSettings(next: SearchSettings) {
    setSettings(next);
    setSettingsError(null);
    const providerId = next.features.chat?.providerId;
    if (providerId && chatProviderPresets.some((preset) => preset.providerId === providerId)) {
      setSetupProviderId(providerId);
    }
  }

  function handleProviderSettingsChange(next: SearchSettings) {
    applyProviderSettings(next);
    void refreshModels();
  }

  function activateWorkspaceNode(nodeId: string | null) {
    if (!nodeId) return;
    explorerStore?.selectArtifact(nodeId, false);
    explorerStore?.activateArtifact(nodeId);
    onActivateSource?.();
  }

  function handleCitationClick(citation: ChatCitation | null) {
    if (!citation?.nodeId || citation.sourceKind !== "workspace") return;
    activateWorkspaceNode(citation.nodeId);
  }

  async function refreshSessions(preferredId?: string) {
    const next = await client.listSessions();
    setSessions(next);
    const current = active?.session.id && next.some((session) => session.id === active.session.id)
      ? active.session.id
      : null;
    const target = preferredId ?? current;
    if (target) {
      const detail = await client.getSession({ sessionId: target });
      setActive(detail);
      reconcileOptimisticMessages(detail);
    } else {
      setActive(null);
    }
  }

  async function ensureSession(title: string): Promise<ChatSessionDetail> {
    if (active) {
      if (shouldRetitleSession(active)) {
        const updated = await client.updateSessionTitle({
          sessionId: active.session.id,
          title,
        });
        const detail = { ...active, session: updated };
        setActive(detail);
        reconcileOptimisticMessages(detail);
        setSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
        return detail;
      }
      return active;
    }

    const session = await client.createSession({ title });
    const detail = await client.getSession({ sessionId: session.id });
    setActive(detail);
    reconcileOptimisticMessages(detail);
    setSessions((items) => [session, ...items]);
    return detail;
  }

  async function createNewSession() {
    if (isCurrentChatEmpty(active, turn, optimisticTranscript.length)) return;
    if (active?.session.id) {
      await triggerMemoryOpportunity(active.session.id);
    }
    setActive(null);
    setTurn(null);
    resetMemoryBody();
    clearContextDraft();
    setQuery("");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    if (!chatProviderReady) {
      setError("Configure a chat provider before sending.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await ensureSession(sessionTitleFromQuery(trimmedQuery));
      const optimisticMessage = {
        id: `optimistic-${session.session.id}-${Date.now()}`,
        sessionId: session.session.id,
        body: trimmedQuery,
        contextNodes: contextNodes.map(contextNodeForMessageHistory),
        persistedBodyCountAtCreation: persistedUserBodyCount(session, trimmedQuery),
      };
      const turnEventId = createTurnEventId();
      activeTurnEventIdRef.current = turnEventId;
      setOptimisticUserMessages((messages) => [...messages, optimisticMessage]);
      setQuery("");
      setTurn(null);
      const result = await client.startTurn({
        sessionId: session.session.id,
        query: trimmedQuery,
        turnEventId,
        model: selectedModel || null,
        includeWeb: true,
        contextNodes,
      });
      const data = unwrapEnvelope(result.turn);
      if (!data) {
        setError(result.turn.error ?? "Chat runtime is still starting.");
        return;
      }
      if (data.state !== "ready" && !data.answer) {
        setError(data.warnings[0] ?? chatStatusMessage(data.state));
      }
      setTurn(data);
      clearContextDraft();
      await refreshSessions(session.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      activeTurnEventIdRef.current = null;
      setBusy(false);
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function deleteSession(session: ChatSession) {
    setDeletingId(session.id);
    setError(null);
    try {
      const result = await client.deleteSession({ sessionId: session.id });
      if (!result.deleted) {
        setError("Chat session was not deleted.");
        return;
      }

      const next = await client.listSessions();
      setSessions(next);
      setSessionMenu(null);
      setOptimisticUserMessages((messages) =>
        messages.filter((message) => message.sessionId !== session.id)
      );

      if (active?.session.id === session.id) {
        const fallback = next[0];
        setTurn(null);
        resetMemoryBody();
        clearContextDraft();
        setQuery("");
        if (fallback) {
          const detail = await client.getSession({ sessionId: fallback.id });
          setActive(detail);
        } else {
          setActive(null);
        }
      }
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleteTarget(null);
    } finally {
      setDeletingId(null);
    }
  }

  async function addContextSelection(selection: SearchPaletteSelection) {
    if (contextNodes.some((node) => node.nodeId === selection.nodeId)) return;
    setContextError(null);
    try {
      const envelope = await searchClient.nodeContent(selection.nodeId);
      const content = unwrapEnvelope(envelope)?.joined;
      setContextNodes((nodes) => [
        ...nodes,
        {
          nodeId: selection.nodeId,
          title: selection.name,
          kind: selection.kind ?? null,
          path: selection.path ?? null,
          snippet: selection.snippet ?? null,
          content: content ? content.slice(0, CONTEXT_CONTENT_LIMIT) : selection.snippet ?? null,
        },
      ]);
      setContextOpen(false);
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Context unavailable.");
    }
  }

  function removeContextNode(nodeId: string) {
    setContextNodes((nodes) => nodes.filter((node) => node.nodeId !== nodeId));
  }

  function clearContextDraft() {
    setContextNodes([]);
    setContextOpen(false);
    setContextError(null);
  }

  async function selectSession(sessionId: string) {
    if (active?.session.id && active.session.id !== sessionId) {
      await triggerMemoryOpportunity(active.session.id);
    }
    setTurn(null);
    resetMemoryBody();
    await refreshSessions(sessionId);
  }

  async function triggerMemoryOpportunity(sessionId: string) {
    try {
      await client.triggerMemoryOpportunity({ sessionId, reason: "session_switch" });
    } catch {
      // Memory refresh is opportunistic and must not block navigation.
    }
  }

  async function openMemoryPanel() {
    const sessionId = active?.session.id;
    if (!sessionId) return;
    setMemoryOpen(true);
    setMemoryExportedNoteId(null);
    await loadMemoryBody(sessionId);
    window.requestAnimationFrame(() => memoryPanelRef.current?.focus());
  }

  function closeMemoryPanel() {
    setMemoryOpen(false);
    window.requestAnimationFrame(() => memoryButtonRef.current?.focus());
  }

  async function loadMemoryBody(sessionId: string) {
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const result = await client.getSessionMemory({ sessionId });
      if (!result.available || !result.body) {
        setMemoryBody("");
        setMemoryRevision(null);
        return;
      }
      setMemoryBody(result.body);
      setMemoryRevision(result.revision ?? null);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err));
      setMemoryBody("");
      setMemoryRevision(null);
    } finally {
      setMemoryLoading(false);
    }
  }

  async function exportMemory() {
    const sessionId = active?.session.id;
    if (!sessionId || !memoryBody || memoryExporting) return;
    setMemoryExporting(true);
    setMemoryError(null);
    setMemoryExportedNoteId(null);
    try {
      const result = await client.exportSessionMemory({ sessionId });
      setMemoryExportedNoteId(result.noteId);
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setMemoryExporting(false);
    }
  }

  function resetMemoryBody() {
    setMemoryBody("");
    setMemoryRevision(null);
    setMemoryError(null);
    setMemoryExportedNoteId(null);
  }

  function reconcileOptimisticMessages(detail: ChatSessionDetail) {
    setOptimisticUserMessages((messages) => {
      const unrelatedMessages = messages.filter((message) => message.sessionId !== detail.session.id);
      const unpersistedMessages = optimisticMessagesForSession(messages, detail);
      if (unrelatedMessages.length + unpersistedMessages.length === messages.length) return messages;

      return [...unrelatedMessages, ...unpersistedMessages];
    });
  }

  const transcript = active?.messages ?? [];
  const optimisticTranscript = active ? optimisticMessagesForSession(optimisticUserMessages, active) : [];
  const selectableModels = models.filter((model) => model.supportsAgentic !== false);
  const modelUnavailableReason =
    !modelsLoading && models.length > 0 && selectableModels.length === 0
      ? models[0]?.unavailableReason ?? "No configured model supports agentic chat tools."
      : null;
  const currentChatIsEmpty = isCurrentChatEmpty(
    active,
    turn,
    optimisticTranscript.length
  );
  const showTransientAnswer = Boolean(
    turn?.answer &&
      !transcript.some((message) => message.role === "assistant" && message.body === turn.answer),
  );
  const transientToolEvents = toolEventsFromUnknown(turn?.toolEvents);
  const showAssistantLoading = Boolean(busy && optimisticTranscript.length > 0 && !turn?.answer && !error);
  const title = active?.session.title ?? "New chat";
  const memoryAvailable = Boolean(active?.memory?.available);
  const renderableMemoryBody = memoryBody ? normalizeMemoryMarkdown(memoryBody) : "";
  const hasSessionHistory = sessions.length > 0;
  const chatProviderReady = !modelsLoading && selectableModels.length > 0;
  const showProviderSetup = !modelsLoading && Boolean(settings) && models.length === 0;
  const composerDisabled = busy || !chatProviderReady || settingsLoading || Boolean(settingsError && !settings);
  const webSearchProviderId = settings?.features["web-search"]?.providerId ?? null;
  const webSearchEnabled = Boolean(
    settings?.features["web-search"]?.enabled &&
      webSearchProviderId &&
      settings.providers[webSearchProviderId]?.enabled
  );

  useEffect(() => {
    if (!visible || !pendingComposerFocusRef.current || composerDisabled || showProviderSetup) return;
    composerRef.current?.focus();
    pendingComposerFocusRef.current = false;
  }, [visible, composerDisabled, showProviderSetup]);

  useEffect(() => {
    if (!visible) return;
    transcriptEndRef.current?.scrollIntoView?.({ block: "end", inline: "nearest" });
  }, [
    visible,
    active?.session.id,
    transcript.length,
    optimisticTranscript.length,
    showAssistantLoading,
    transientToolEvents.length,
    turn?.answer,
  ]);

  return (
    <section
      className={`chat-layout${memoryOpen ? " has-memory-panel" : ""}${hasSessionHistory ? "" : " has-no-session-list"}`}
      aria-label="Chat"
    >
      {hasSessionHistory ? (
        <aside className="chat-session-list" aria-label="Chat sessions">
          <div className="chat-section-head chat-sidebar-head">
            <button
              type="button"
              className="icon-button chat-new-session-button"
              onClick={createNewSession}
              aria-label="Start new chat"
              disabled={busy || currentChatIsEmpty}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="chat-session-stack">
            {sessions.map((session) => {
              const isActive = active?.session.id === session.id;

              return (
                <div
                  key={session.id}
                  className={`chat-session-row${isActive ? " is-active" : ""}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSessionMenu({ session, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button
                    type="button"
                    className="chat-session-item"
                    onClick={() => void selectSession(session.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setSessionMenu({
                        session,
                        x: rect.left + Math.min(rect.width - 12, 160),
                        y: rect.top + Math.min(rect.height - 4, 44),
                      });
                    }}
                  >
                    <span className="chat-session-title">{session.title}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      ) : null}

      <main className="chat-main">
        <header className="chat-topbar">
          <div className="chat-title-block">
            <span className="chat-kicker">
              <MessageSquare size={14} aria-hidden="true" />
              Workspace chat
            </span>
            <h2>{title}</h2>
          </div>
          <div className="chat-topbar-actions">
            <button
              ref={memoryButtonRef}
              className="chat-runtime-pill chat-memory-trigger"
              type="button"
              disabled={!memoryAvailable}
              aria-label="Open Session Memory"
              aria-expanded={memoryOpen}
              onClick={() => void openMemoryPanel()}
            >
              <BookOpen size={14} aria-hidden="true" />
              Memory
            </button>
          </div>
        </header>

        {error ? (
          <p className="chat-error" role="status"><CircleAlert size={15} aria-hidden="true" /> {error}</p>
        ) : null}

        <section className={`chat-transcript${transcript.length === 0 && optimisticTranscript.length === 0 && !turn ? " is-empty" : ""}`} aria-label="Transcript">
          {transcript.length === 0 && optimisticTranscript.length === 0 && !turn ? (
            <div className="chat-empty">
              <Search size={24} aria-hidden="true" />
              <h3>{workspaceIsEmpty ? "Add content first" : "Ask CogniOS"}</h3>
              <p>
                {workspaceIsEmpty
                  ? "Mount a folder, create a note, or record a voice note before asking grounded questions."
                  : "Timeline, costs, causes, evidence gaps."}
              </p>
            </div>
          ) : null}
          {transcript.map((message) => {
            const attachedContext = contextNodesFromMessage(message);
            const citations = citationsFromMessage(message);

            return (
              <article key={message.id} className={`chat-message is-${message.role}`}>
                {message.role === "system" ? <p className="chat-message-role">{message.role}</p> : null}
                <MessageContextNodes
                  nodes={attachedContext}
                  onActivateNode={activateWorkspaceNode}
                />
                {message.role === "assistant" ? <ChatToolActivity events={toolEventsFromMessage(message)} /> : null}
                <ChatMessageBody
                  role={message.role}
                  body={message.body}
                  citations={citations}
                  onCitationClick={handleCitationClick}
                />
              </article>
            );
          })}
          {optimisticTranscript.map((message) => (
            <article key={message.id} className="chat-message is-user">
              <MessageContextNodes
                nodes={message.contextNodes}
                onActivateNode={activateWorkspaceNode}
              />
              <ChatMessageBody role="user" body={message.body} />
            </article>
          ))}
          {showTransientAnswer ? (
            <article className="chat-message is-assistant">
              <ChatToolActivity events={transientToolEvents} />
              <ChatMessageBody
                role="assistant"
                body={turn?.answer ?? ""}
                citations={citationsFromUnknown(turn?.citations)}
                onCitationClick={handleCitationClick}
              />
            </article>
          ) : null}
          {showAssistantLoading ? (
            <article className="chat-message is-assistant is-loading">
              <ChatToolActivity events={transientToolEvents} />
              <AssistantLoading />
            </article>
          ) : null}
          <div ref={transcriptEndRef} className="chat-transcript-end" aria-hidden="true" />
        </section>

        {settingsLoading ? (
          <div className="chat-provider-status">
            <p className="chat-provider-setup-note">Loading chat provider settings...</p>
          </div>
        ) : null}
        {settingsError && !settings ? (
          <div className="chat-provider-status">
            <p className="chat-provider-setup-error" role="alert">
              {settingsError}
            </p>
          </div>
        ) : null}
        {showProviderSetup && settings ? (
          <ChatProviderSetup
            settings={settings}
            selectedProviderId={setupProviderId}
            providerStatus={modelsStatus}
            client={searchClient}
            onSelectedProviderChange={setSetupProviderId}
            onSettingsChange={handleProviderSettingsChange}
          />
        ) : null}

        {!showProviderSetup ? (
          <form className="chat-composer" aria-label="Chat composer" onSubmit={submit}>
          {contextNodes.length > 0 || contextError ? (
            <div className="chat-context-area">
              {contextNodes.length > 0 ? (
                <div className="chat-context-chips" aria-label="Context nodes">
                  {contextNodes.map((node) => (
                    <span
                      className="chat-context-chip"
                      key={node.nodeId}
                      title={node.path ?? node.title}
                    >
                      <ContextNodeIcon node={node} />
                      <span>{node.title}</span>
                      <button
                        type="button"
                        aria-label={`Remove context ${node.title}`}
                        onClick={() => removeContextNode(node.nodeId)}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {contextError ? <p className="chat-context-status">{contextError}</p> : null}
            </div>
          ) : null}
          <textarea
            ref={composerRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              chatProviderReady
                ? "Ask about a timeline, cost, cause, evidence gaps..."
                : models.length > 0
                  ? "Select a tool-capable model to start..."
                : "Configure a chat provider to start..."
            }
            aria-label="Chat message"
            disabled={composerDisabled}
          />
          <div className="chat-composer-footer">
            <div className="chat-composer-meta-group">
              {models.length > 0 ? (
                <AppSelect
                  label="Model"
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={models.map((model) => ({
                    value: model.id,
                    label: model.name,
                    disabled: model.supportsAgentic === false,
                    disabledReason: model.unavailableReason,
                  }))}
                  className="chat-model-picker"
                />
              ) : null}
              {modelUnavailableReason ? (
                <span className="chat-model-unavailable" role="status">
                  {modelUnavailableReason}
                </span>
              ) : null}
              {webSearchEnabled ? (
                <span
                  className="chat-web-search-indicator"
                  role="img"
                  aria-label="Web search enabled"
                  title="Web search enabled"
                >
                  <Globe size={14} aria-hidden="true" />
                </span>
              ) : null}
            </div>
            <div className="chat-composer-actions">
              <button
                className="chat-context-toggle"
                type="button"
                title="Add context"
                aria-label="Add context"
                aria-expanded={contextOpen}
                disabled={!chatProviderReady}
                onClick={() => setContextOpen((open) => !open)}
              >
                <Paperclip size={15} aria-hidden="true" />
              </button>
              <button className="chat-primary-action" type="submit" disabled={composerDisabled || !query.trim()}>
                <Send size={15} aria-hidden="true" />
                {busy ? "Waiting..." : "Send"}
              </button>
            </div>
          </div>
          </form>
        ) : null}
      </main>

      {memoryOpen ? (
        <aside
          ref={memoryPanelRef}
          className="chat-memory-panel"
          aria-labelledby="chat-memory-title"
          aria-describedby="chat-memory-description"
          tabIndex={-1}
        >
          <header className="chat-memory-header">
            <div>
              <p className="chat-memory-eyebrow">Read-only</p>
              <h2 id="chat-memory-title">Session Memory</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close Session Memory"
              onClick={closeMemoryPanel}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <p id="chat-memory-description" className="chat-memory-copy">
            Generated from this chat. Recent turns that have not been compacted remain in the transcript.
          </p>
          <p className="chat-memory-status">
            Memory snapshot{memoryRevision ? ` · revision ${memoryRevision}` : ""}
          </p>

          <div className="chat-memory-body" aria-live="polite">
            {memoryLoading ? <p className="chat-memory-placeholder">Loading memory...</p> : null}
            {!memoryLoading && memoryError ? (
              <div className="chat-memory-error" role="alert">
                <p>{memoryError}</p>
                {active?.session.id ? (
                  <button type="button" onClick={() => void loadMemoryBody(active.session.id)}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {!memoryLoading && !memoryError && renderableMemoryBody ? (
              <div className="chat-message-markdown chat-memory-markdown markdown-body">
                <MarkdownRenderer allowHtml={false}>{renderableMemoryBody}</MarkdownRenderer>
              </div>
            ) : null}
            {!memoryLoading && !memoryError && !renderableMemoryBody ? (
              <p className="chat-memory-placeholder">Session Memory is not available yet.</p>
            ) : null}
          </div>

          <footer className="chat-memory-footer">
            {memoryExportedNoteId ? (
              <p className="chat-memory-saved" role="status">
                Saved as editable Note snapshot.
              </p>
            ) : null}
            <button
              type="button"
              className="chat-memory-export"
              disabled={!memoryBody || memoryLoading || memoryExporting}
              onClick={() => void exportMemory()}
            >
              {memoryExporting ? "Saving..." : "Save as Note"}
            </button>
          </footer>
        </aside>
      ) : null}

      {sessionMenu ? (
        <div
          className="tree-context-menu chat-session-context-menu"
          role="menu"
          style={{ top: sessionMenu.y, left: sessionMenu.x }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="tree-context-item tree-context-item--danger"
            role="menuitem"
            type="button"
            disabled={busy || deletingId !== null}
            onClick={() => {
              setDeleteTarget(sessionMenu.session);
              setSessionMenu(null);
            }}
          >
            Delete
          </button>
        </div>
      ) : null}

      {contextOpen ? (
        <SearchPalette
          client={searchClient}
          onClose={() => setContextOpen(false)}
          onActivate={() => {}}
          onSelectNode={(selection) => void addContextSelection(selection)}
        />
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay" onClick={(event) => {
          if (event.target === event.currentTarget && !deletingId) setDeleteTarget(null);
        }}>
          <div
            className="modal chat-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-delete-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">Delete chat</p>
                <h2 className="modal-title" id="chat-delete-title">{deleteTarget.title}</h2>
              </div>
            </header>
            <div className="modal-body">
              <p className="muted-copy">This deletes the chat history for this session.</p>
            </div>
            <footer className="modal-footer">
              <button
                className="ghost-button"
                type="button"
                disabled={deletingId !== null}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={deletingId !== null}
                onClick={() => void deleteSession(deleteTarget)}
              >
                {deletingId === deleteTarget.id ? "Deleting..." : "Delete"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AssistantLoading() {
  return (
    <div className="chat-message-loading" role="status" aria-live="polite">
      <span>Thinking</span>
      <span className="chat-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

function ChatToolActivity({ events }: { events: ChatToolEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="chat-tool-activity" aria-label="Workspace activity">
      {events.map((event, index) => (
        <span
          className="chat-tool-activity-item"
          data-status={event.status}
          key={`${event.toolName}-${event.nodeId ?? event.resultCount ?? index}`}
        >
          <Search size={12} aria-hidden="true" />
          <span>{event.summary}</span>
        </span>
      ))}
    </div>
  );
}

function ChatMessageBody({
  role,
  body,
  citations = [],
  onCitationClick,
}: {
  role: ChatMessageRole;
  body: string;
  citations?: ChatCitation[];
  onCitationClick?: (citation: ChatCitation | null) => void;
}) {
  if (role !== "assistant") {
    return <p className="chat-message-body">{body}</p>;
  }

  const citationByLabel = new Map(citations.map((citation) => [citation.marker, citation]));

  return (
    <div className="chat-message-body chat-message-markdown markdown-body">
      <MarkdownRenderer
        allowHtml={false}
        components={chatMarkdownComponents(citationByLabel, onCitationClick)}
      >
        {formatInlineCitations(body)}
      </MarkdownRenderer>
    </div>
  );
}

function chatMarkdownComponents(
  citationByLabel: Map<string, ChatCitation>,
  onCitationClick?: (citation: ChatCitation | null) => void
) {
  return {
    a({
      node: _node,
      href,
      children,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
      const label = citationLabelFromHref(href);
      if (!label) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }

      const citation = citationByLabel.get(label) ?? null;
      return (
        <a
          href={href}
          {...props}
          className="chat-inline-citation"
          data-citation-kind={citation?.sourceKind ?? undefined}
          aria-label={citationAriaLabel(label, citation)}
          title={citationTitle(label, citation)}
          onClick={(event) => {
            event.preventDefault();
            onCitationClick?.(citation);
          }}
        >
          {citationDisplayLabel(label)}
        </a>
      );
    },
  };
}

function formatInlineCitations(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceMarker: string | null = null;

  return lines
    .map((line) => {
      const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2][0];
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (fenceMarker === marker) {
          inFence = false;
          fenceMarker = null;
        }
        return line;
      }

      return inFence ? line : replaceCitationsOutsideInlineCode(line);
    })
    .join("\n");
}

function replaceCitationsOutsideInlineCode(line: string): string {
  let result = "";
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      const nextCode = line.indexOf("`", index);
      const end = nextCode === -1 ? line.length : nextCode;
      result += linkifyCitationSegment(line.slice(index, end));
      index = end;
      continue;
    }

    const runStart = index;
    while (index < line.length && line[index] === "`") index += 1;
    const run = line.slice(runStart, index);
    const closing = line.indexOf(run, index);
    if (closing === -1) {
      result += line.slice(runStart);
      break;
    }
    result += line.slice(runStart, closing + run.length);
    index = closing + run.length;
  }

  return result;
}

function linkifyCitationSegment(segment: string): string {
  return segment.replace(/\[((?:WEB|W)\d+)\](?!\()/g, (match, label: string, offset: number) => {
    if (segment[offset - 1] === "\\") return match;
    return `[${label}](#citation-${label})`;
  });
}

function citationLabelFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = /^#citation-((?:WEB|W)\d+)$/.exec(href);
  return match?.[1] ?? null;
}

function citationAriaLabel(label: string, citation: ChatCitation | null): string {
  const sourceLabel = citationSourceLabel(citation);
  return sourceLabel ? `Citation ${label}: ${sourceLabel}` : `Citation ${label}`;
}

function citationTitle(label: string, citation: ChatCitation | null): string {
  if (!citation) return `Citation ${label}`;
  const parts = [citationSourceLabel(citation), citation.path].filter(Boolean);
  return parts.join(" - ");
}

function citationDisplayLabel(label: string): string {
  return label.replace(/^(?:WEB|W)/, "");
}

function citationSourceLabel(citation: ChatCitation | null): string | null {
  return citation?.label ?? citation?.title ?? null;
}

function MessageContextNodes({
  nodes,
  onActivateNode,
}: {
  nodes: ChatContextNode[];
  onActivateNode?: (nodeId: string) => void;
}) {
  if (nodes.length === 0) return null;

  return (
    <div className="chat-message-context" aria-label="Attached context">
      {nodes.map((node) => {
        const title = node.path ?? node.title;
        const children = (
          <>
            <ContextNodeIcon node={node} />
            <span>{node.title}</span>
          </>
        );

        return onActivateNode ? (
          <button
            type="button"
            className="chat-context-chip chat-message-context-chip"
            key={`${node.nodeId}:${title}`}
            title={title}
            aria-label={`Open context ${node.title}`}
            onClick={() => onActivateNode(node.nodeId)}
          >
            {children}
          </button>
        ) : (
          <span
            className="chat-context-chip chat-message-context-chip"
            key={`${node.nodeId}:${title}`}
            title={title}
          >
            {children}
          </span>
        );
      })}
    </div>
  );
}

function contextNodesFromMessage(message: ChatMessage): ChatContextNode[] {
  if (message.role !== "user") return [];

  try {
    const metadata = JSON.parse(message.metadataJson);
    if (!isRecord(metadata) || !Array.isArray(metadata.contextNodes)) return [];
    return metadata.contextNodes
      .map(normalizeContextNodeFromMetadata)
      .filter((node): node is ChatContextNode => Boolean(node));
  } catch {
    return [];
  }
}

function normalizeContextNodeFromMetadata(value: unknown): ChatContextNode | null {
  if (!isRecord(value)) return null;
  const nodeId = stringValue(value.nodeId) ?? stringValue(value.node_id);
  const title =
    stringValue(value.title) ??
    stringValue(value.name) ??
    stringValue(value.path) ??
    nodeId;
  if (!nodeId || !title) return null;

  return {
    nodeId,
    title,
    kind: stringValue(value.kind),
    path: stringValue(value.path),
    snippet: stringValue(value.snippet),
  };
}

function citationsFromMessage(message: ChatMessage): ChatCitation[] {
  if (message.role !== "assistant") return [];

  try {
    const metadata = JSON.parse(message.metadataJson);
    return isRecord(metadata) ? citationsFromUnknown(metadata.citations) : [];
  } catch {
    return [];
  }
}

function toolEventsFromMessage(message: ChatMessage): ChatToolEvent[] {
  if (message.role !== "assistant") return [];

  try {
    const metadata = JSON.parse(message.metadataJson);
    return isRecord(metadata) ? toolEventsFromUnknown(metadata.toolEvents) : [];
  } catch {
    return [];
  }
}

function citationsFromUnknown(value: unknown): ChatCitation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeCitation)
    .filter((citation): citation is ChatCitation => Boolean(citation));
}

function toolEventsFromUnknown(value: unknown): ChatToolEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeToolEvent)
    .filter((event): event is ChatToolEvent => Boolean(event));
}

function normalizeCitation(value: unknown): ChatCitation | null {
  if (!isRecord(value)) return null;
  const marker = stringValue(value.marker) ?? stringValue(value.label);
  if (!marker) return null;
  const sourceKind = stringValue(value.sourceKind) ?? stringValue(value.source_kind);
  const citation = stringValue(value.citation);

  return {
    marker,
    label: stringValue(value.label),
    nodeId: stringValue(value.nodeId) ?? stringValue(value.node_id) ?? (sourceKind === "workspace" ? citation : null),
    citation,
    title: stringValue(value.title),
    sourceKind,
    path: stringValue(value.path),
  };
}

function normalizeToolEvent(value: unknown): ChatToolEvent | null {
  if (!isRecord(value)) return null;
  const toolName = stringValue(value.toolName) ?? stringValue(value.tool_name);
  const summary = stringValue(value.summary);
  if (!toolName || !summary) return null;
  const resultCount = numberValue(value.resultCount) ?? numberValue(value.result_count);

  return {
    toolName,
    summary,
    status: stringValue(value.status) ?? "ok",
    nodeId: stringValue(value.nodeId) ?? stringValue(value.node_id),
    resultCount,
  };
}

function contextNodeForMessageHistory(node: ChatContextNode): ChatContextNode {
  return {
    nodeId: node.nodeId,
    title: node.title,
    kind: node.kind,
    path: node.path,
    snippet: node.snippet,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeMemoryMarkdown(body: string): string {
  const trimmed = body.trim();
  const fencedMarkdown = /^```(?:markdown|md|gfm)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(trimmed);
  if (!fencedMarkdown) return body;
  return fencedMarkdown[1].trim();
}

function shouldRetitleSession(detail: ChatSessionDetail): boolean {
  const title = detail.session.title.trim().toLowerCase();
  return detail.messages.length === 0 && (title === "new chat" || title === "research chat");
}

function isCurrentChatEmpty(
  detail: ChatSessionDetail | null,
  turn: ChatTurnResponse | null,
  optimisticCount = 0
): boolean {
  return !turn && optimisticCount === 0 && (!detail || detail.messages.length === 0);
}

function optimisticMessagesForSession(
  messages: OptimisticUserMessage[],
  detail: ChatSessionDetail
): OptimisticUserMessage[] {
  const persistedUserBodyCounts = new Map<string, number>();
  for (const message of detail.messages) {
    if (message.role !== "user") continue;
    persistedUserBodyCounts.set(message.body, (persistedUserBodyCounts.get(message.body) ?? 0) + 1);
  }

  return messages.filter((message) => {
    if (message.sessionId !== detail.session.id) return false;
    const persistedCount = persistedUserBodyCounts.get(message.body) ?? 0;
    return persistedCount <= message.persistedBodyCountAtCreation;
  });
}

function persistedUserBodyCount(detail: ChatSessionDetail, body: string): number {
  return detail.messages.filter((message) => message.role === "user" && message.body === body).length;
}

function ContextNodeIcon({ node }: { node: ChatContextNode }) {
  const Icon = iconForContextNode(node);
  return <Icon size={13} aria-hidden="true" />;
}

function iconForContextNode(node: ChatContextNode) {
  switch (node.kind) {
    case "mount":
      return HardDrive;
    case "folder":
      return Folder;
    case "url":
      return Globe;
    case "file": {
      const ext = extensionOf(node.path ?? node.title);
      if (["md", "mdx", "txt", "markdown"].includes(ext)) return FileText;
      return File;
    }
    case "note":
    default:
      return FileText;
  }
}

function extensionOf(name: string) {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function chatStatusMessage(state: string): string {
  if (state === "provider_unavailable") return "Chat provider unavailable.";
  if (state === "provider_error") return "Chat provider returned an error.";
  return "Chat could not complete.";
}

function chatModelsStatusMessage(
  data: ChatModelsResponse | null,
  envelopeError?: string
): string {
  if (data?.warnings[0]) return data.warnings[0];
  if (data?.state === "provider_error") return "Chat provider returned an error.";
  if (data?.state === "provider_unavailable") return "No configured chat provider is ready.";
  return envelopeError ?? "Chat provider unavailable.";
}

function sessionTitleFromQuery(query: string): string {
  const compact = query
    .replace(/\s+/g, " ")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[。！？!?.,，、；;：:]+$/g, "")
    .trim();
  if (!compact) return "New chat";

  const maxLength = containsCjk(compact) ? 18 : 48;
  const chars = Array.from(compact);
  if (chars.length <= maxLength) return compact;
  return `${chars.slice(0, maxLength).join("").trim()}...`;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function createTurnEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
