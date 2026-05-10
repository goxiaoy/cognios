import {
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
  ChatMessageRole,
  ChatSession,
  ChatSessionDetail,
  ChatModel,
  ChatSessionMemoryEventPayload,
  ChatTurnResponse,
  ChatTurnStreamPayload,
} from "../../../lib/contracts/chat";
import { AppSelect } from "../../../components/FormControls";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import { MarkdownRenderer } from "../../explorer/components/MarkdownRenderer";
import { SearchPalette, type SearchPaletteSelection } from "../../search/components/SearchPalette";
import type { SearchClient } from "../../search/types/search";
import type { ChatClient } from "../api/chatClient";

const CONTEXT_CONTENT_LIMIT = 8_000;
const CHAT_TURN_EVENT = "chat/turn";
const CHAT_MEMORY_EVENT = "chat/session-memory";

interface OptimisticUserMessage {
  id: string;
  sessionId: string;
  body: string;
  persistedBodyCountAtCreation: number;
}

export function ChatLayout({ client, searchClient }: { client: ChatClient; searchClient: SearchClient }) {
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
  const [selectedModel, setSelectedModel] = useState("");
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

  useEffect(() => {
    void refreshSessions();
    void refreshModels();
  }, []);

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
    try {
      const result = await client.getModels();
      const data = unwrapEnvelope(result.models);
      if (!data || data.state !== "ready") return;
      setModels(data.models);
      setSelectedModel((current) => current || data.models[0]?.id || "");
    } catch {
      setModels([]);
    }
  }

  async function refreshSessions(preferredId?: string) {
    const next = await client.listSessions();
    setSessions(next);
    const current = active?.session.id && next.some((session) => session.id === active.session.id)
      ? active.session.id
      : null;
    const target = preferredId ?? current ?? next[0]?.id;
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
    setBusy(true);
    setError(null);
    try {
      const session = await ensureSession(sessionTitleFromQuery(trimmedQuery));
      const optimisticMessage = {
        id: `optimistic-${session.session.id}-${Date.now()}`,
        sessionId: session.session.id,
        body: trimmedQuery,
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
  const currentChatIsEmpty = isCurrentChatEmpty(
    active,
    turn,
    optimisticTranscript.length
  );
  const showTransientAnswer = Boolean(
    turn?.answer &&
      !transcript.some((message) => message.role === "assistant" && message.body === turn.answer),
  );
  const showAssistantLoading = Boolean(busy && optimisticTranscript.length > 0 && !turn?.answer && !error);
  const title = active?.session.title ?? "New chat";
  const memoryAvailable = Boolean(active?.memory?.available);
  const renderableMemoryBody = memoryBody ? normalizeMemoryMarkdown(memoryBody) : "";

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
  }, [active?.session.id, transcript.length, optimisticTranscript.length, showAssistantLoading, turn?.answer]);

  return (
    <section className={`chat-layout${memoryOpen ? " has-memory-panel" : ""}`} aria-label="Chat">
      <aside className="chat-session-list" aria-label="Chat sessions">
        <div className="chat-section-head chat-sidebar-head">
          <h2>Chats</h2>
          <button
            type="button"
            className="icon-button"
            onClick={createNewSession}
            aria-label="Start new chat"
            disabled={busy || currentChatIsEmpty}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="chat-session-stack">
          {sessions.length === 0 ? <p className="chat-session-empty">No chats yet</p> : null}
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
            <span className="chat-runtime-pill">
              <Globe size={14} aria-hidden="true" />
              Web
            </span>
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
              <h3>Ask CogniOS</h3>
              <p>Timeline, costs, causes, evidence gaps.</p>
            </div>
          ) : null}
          {transcript.map((message) => (
            <article key={message.id} className={`chat-message is-${message.role}`}>
              {message.role === "system" ? <p className="chat-message-role">{message.role}</p> : null}
              <ChatMessageBody role={message.role} body={message.body} />
            </article>
          ))}
          {optimisticTranscript.map((message) => (
            <article key={message.id} className="chat-message is-user">
              <ChatMessageBody role="user" body={message.body} />
            </article>
          ))}
          {showTransientAnswer ? (
            <article className="chat-message is-assistant">
              <ChatMessageBody role="assistant" body={turn?.answer ?? ""} />
            </article>
          ) : null}
          {showAssistantLoading ? (
            <article className="chat-message is-assistant is-loading">
              <AssistantLoading />
            </article>
          ) : null}
          <div ref={transcriptEndRef} className="chat-transcript-end" aria-hidden="true" />
        </section>

        <form className="chat-composer" aria-label="Chat composer" onSubmit={submit}>
          {contextNodes.length > 0 || contextError ? (
            <div className="chat-context-area">
              {contextNodes.length > 0 ? (
                <div className="chat-context-chips" aria-label="Context nodes">
                  {contextNodes.map((node) => (
                    <span className="chat-context-chip" key={node.nodeId}>
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
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Ask about a timeline, cost, cause, evidence gaps..."
            aria-label="Chat message"
          />
          <div className="chat-composer-footer">
            <div className="chat-composer-meta-group">
              {models.length > 0 ? (
                <AppSelect
                  label="Model"
                  value={selectedModel}
                  onChange={setSelectedModel}
                  options={models.map((model) => ({ value: model.id, label: model.name }))}
                  className="chat-model-picker"
                />
              ) : null}
              <span className="chat-composer-meta">
                <Globe size={14} aria-hidden="true" />
                Workspace + web{contextNodes.length > 0 ? ` + ${contextNodes.length} context` : ""}
              </span>
            </div>
            <div className="chat-composer-actions">
              <button
                className="chat-context-toggle"
                type="button"
                title="Add context"
                aria-label="Add context"
                aria-expanded={contextOpen}
                onClick={() => setContextOpen((open) => !open)}
              >
                <Paperclip size={15} aria-hidden="true" />
              </button>
              <button className="chat-primary-action" type="submit" disabled={busy || !query.trim()}>
                <Send size={15} aria-hidden="true" />
                {busy ? "Waiting..." : "Send"}
              </button>
            </div>
          </div>
        </form>
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

function ChatMessageBody({
  role,
  body,
}: {
  role: ChatMessageRole;
  body: string;
}) {
  if (role !== "assistant") {
    return <p className="chat-message-body">{body}</p>;
  }

  return (
    <div className="chat-message-body chat-message-markdown markdown-body">
      <MarkdownRenderer allowHtml={false}>{body}</MarkdownRenderer>
    </div>
  );
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
