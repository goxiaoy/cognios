import { FormEvent, useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, FileText, Globe, MessageSquare, Plus, Search, Sparkles } from "lucide-react";

import type {
  ChatSession,
  ChatSessionDetail,
  ChatModel,
  ChatTurnCluster,
  ChatTurnResponse,
} from "../../../lib/contracts/chat";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import type { ChatClient } from "../api/chatClient";

export function ChatLayout({ client }: { client: ChatClient }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<ChatSessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [turn, setTurn] = useState<ChatTurnResponse | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSessions();
    void refreshModels();
  }, []);

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
        setSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
        return detail;
      }
      return active;
    }

    const session = await client.createSession({ title });
    const detail = await client.getSession({ sessionId: session.id });
    setActive(detail);
    setSessions((items) => [session, ...items]);
    return detail;
  }

  async function createNewSession() {
    if (isCurrentChatEmpty(active, turn)) return;
    setActive(null);
    setTurn(null);
    setAccepted(new Set());
    setQuery("");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    setBusy(true);
    setError(null);
    try {
      const session = await ensureSession(sessionTitleFromQuery(trimmedQuery));
      const result = await client.startTurn({
        sessionId: session.session.id,
        query: trimmedQuery,
        model: selectedModel || null,
        includeWeb: true,
      });
      const data = unwrapEnvelope(result.turn);
      if (!data) {
        setError(result.turn.error ?? "Chat runtime is still starting.");
        return;
      }
      setTurn(data);
      setAccepted(new Set());
      await refreshSessions(session.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function synthesize() {
    if (!active || !query.trim() || accepted.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.startTurn({
        sessionId: active.session.id,
        query: query.trim(),
        model: selectedModel || null,
        acceptedClusterIds: [...accepted],
        includeWeb: true,
      });
      const data = unwrapEnvelope(result.turn);
      if (!data) {
        setError(result.turn.error ?? "Chat runtime is still starting.");
        return;
      }
      setTurn(data);
      await refreshSessions(active.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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

      if (active?.session.id === session.id) {
        const fallback = next[0];
        setTurn(null);
        setAccepted(new Set());
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

  const clusters = turn?.clusters ?? [];
  const transcript = active?.messages ?? [];
  const currentChatIsEmpty = isCurrentChatEmpty(active, turn);
  const showTransientAnswer = Boolean(
    turn?.answer &&
      !transcript.some((message) => message.role === "assistant" && message.body === turn.answer),
  );
  const title = active?.session.title ?? "New chat";

  return (
    <section className="chat-layout" aria-label="Chat">
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
                  onClick={() => refreshSessions(session.id)}
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
                  {session.boundNoteId ? (
                    <span className="chat-session-meta">
                      <FileText size={13} aria-hidden="true" />
                      Note
                    </span>
                  ) : null}
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
            {active?.session.boundNoteId ? (
              <span className="chat-runtime-pill">
                <FileText size={14} aria-hidden="true" />
                Note
              </span>
            ) : null}
            {models.length > 0 ? (
              <label className="chat-model-picker">
                Model
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </header>

        {error ? (
          <p className="chat-error" role="status"><CircleAlert size={15} aria-hidden="true" /> {error}</p>
        ) : null}

        <section className={`chat-transcript${transcript.length === 0 && !turn ? " is-empty" : ""}`} aria-label="Transcript">
          {transcript.length === 0 && !turn ? (
            <div className="chat-empty">
              <Search size={24} aria-hidden="true" />
              <h3>Ask CogniOS</h3>
              <p>Timeline, costs, causes, evidence gaps.</p>
            </div>
          ) : null}
          {transcript.map((message) => (
            <article key={message.id} className={`chat-message is-${message.role}`}>
              <p className="chat-message-role">{message.role}</p>
              <p>{message.body}</p>
            </article>
          ))}
          {showTransientAnswer ? (
            <article className="chat-message is-assistant">
              <p className="chat-message-role">assistant</p>
              <p>{turn?.answer}</p>
            </article>
          ) : null}
        </section>

        <form className="chat-composer" onSubmit={submit}>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about a timeline, cost, cause, evidence gaps..."
            aria-label="Chat message"
          />
          <div className="chat-composer-footer">
            <span className="chat-composer-meta">
              <Globe size={14} aria-hidden="true" />
              Workspace + web
            </span>
            <div className="chat-composer-actions">
              <button className="chat-secondary-action" type="submit" disabled={busy || !query.trim()}>
                {busy ? "Working..." : "Search"}
              </button>
              <button
                className="chat-primary-action"
                type="button"
                disabled={busy || accepted.size === 0}
                onClick={synthesize}
              >
                <Sparkles size={15} aria-hidden="true" />
                {accepted.size > 0 ? `Synthesize ${accepted.size}` : "Synthesize"}
              </button>
            </div>
          </div>
        </form>
      </main>

      <SourceClusterPanel
        clusters={clusters}
        accepted={accepted}
        onToggle={(clusterId) => {
          setAccepted((current) => {
            const next = new Set(current);
            if (next.has(clusterId)) next.delete(clusterId);
            else next.add(clusterId);
            return next;
          });
        }}
      />

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

function SourceClusterPanel({
  clusters,
  accepted,
  onToggle,
}: {
  clusters: ChatTurnCluster[];
  accepted: Set<string>;
  onToggle(clusterId: string): void;
}) {
  const visible = useMemo(() => clusters.slice(0, 6), [clusters]);
  const acceptedVisible = visible.filter((cluster) => accepted.has(cluster.clusterId)).length;

  return (
    <aside className="chat-clusters" aria-label="Source clusters">
      <div className="chat-section-head chat-source-head">
        <h2>Sources</h2>
        {visible.length > 0 ? (
          <span>
            {acceptedVisible}/{visible.length}
          </span>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <p className="chat-source-empty">Sources appear after search.</p>
      ) : (
        visible.map((cluster) => (
          <button
            type="button"
            key={cluster.clusterId}
            className={`chat-cluster-item${accepted.has(cluster.clusterId) ? " is-accepted" : ""}`}
            onClick={() => onToggle(cluster.clusterId)}
          >
            <span className="chat-cluster-row">
              <span className="chat-cluster-title">{cluster.title}</span>
              <span className="chat-cluster-check" aria-hidden="true">
                {accepted.has(cluster.clusterId) ? <Check size={14} /> : null}
              </span>
            </span>
            <span className="chat-cluster-kind">{cluster.sourceKind}</span>
            <span className="chat-cluster-summary">{cluster.summary}</span>
          </button>
        ))
      )}
    </aside>
  );
}

function shouldRetitleSession(detail: ChatSessionDetail): boolean {
  const title = detail.session.title.trim().toLowerCase();
  return detail.messages.length === 0 && (title === "new chat" || title === "research chat");
}

function isCurrentChatEmpty(detail: ChatSessionDetail | null, turn: ChatTurnResponse | null): boolean {
  return !turn && (!detail || detail.messages.length === 0);
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
