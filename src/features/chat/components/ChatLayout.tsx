import { FormEvent, useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, FileText, Globe, MessageSquare, Plus, Search } from "lucide-react";

import type {
  ChatSession,
  ChatSessionDetail,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSessions();
  }, []);

  async function refreshSessions(preferredId?: string) {
    const next = await client.listSessions();
    setSessions(next);
    const target = preferredId ?? active?.session.id ?? next[0]?.id;
    if (target) {
      const detail = await client.getSession({ sessionId: target });
      setActive(detail);
    }
  }

  async function ensureSession(): Promise<ChatSessionDetail> {
    if (active) return active;
    const session = await client.createSession({ title: "Research chat" });
    const detail = await client.getSession({ sessionId: session.id });
    setActive(detail);
    setSessions((items) => [session, ...items]);
    return detail;
  }

  async function createNewSession() {
    const session = await client.createSession({ title: "Research chat" });
    await refreshSessions(session.id);
    setTurn(null);
    setAccepted(new Set());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const session = await ensureSession();
      const result = await client.startTurn({
        sessionId: session.session.id,
        query: query.trim(),
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

  const clusters = turn?.clusters ?? [];
  const transcript = active?.messages ?? [];
  const showTransientAnswer = Boolean(
    turn?.answer &&
      !transcript.some((message) => message.role === "assistant" && message.body === turn.answer),
  );

  return (
    <section className="chat-layout" aria-label="Chat research workbench">
      <aside className="chat-session-list" aria-label="Chat sessions">
        <div className="chat-section-head">
          <h2>Sessions</h2>
          <button type="button" className="icon-button" onClick={createNewSession} aria-label="New chat">
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="chat-session-stack">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`chat-session-item${active?.session.id === session.id ? " is-active" : ""}`}
              onClick={() => refreshSessions(session.id)}
            >
              <span>{session.title}</span>
              {session.boundNoteId ? <FileText size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        <div className="chat-status-row">
          <span className="chat-status-pill"><MessageSquare size={14} /> {active ? active.session.title : "New chat"}</span>
          <span className="chat-status-pill"><Globe size={14} /> Web sources stay session-scoped</span>
          {active?.session.boundNoteId ? (
            <span className="chat-status-pill"><FileText size={14} /> Live Note bound</span>
          ) : null}
        </div>

        {error ? (
          <p className="chat-error"><CircleAlert size={15} aria-hidden="true" /> {error}</p>
        ) : null}

        <div className="chat-work-area">
          <section className="chat-transcript" aria-label="Transcript">
            {transcript.length === 0 && !turn ? (
              <div className="chat-empty">
                <Search size={24} aria-hidden="true" />
                <p>Ask a research question across workspace and web sources.</p>
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
        </div>

        <form className="chat-composer" onSubmit={submit}>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about a timeline, cost, cause, evidence gaps..."
          />
          <div className="chat-composer-actions">
            <button type="submit" disabled={busy || !query.trim()}>
              Search clusters
            </button>
            <button type="button" disabled={busy || accepted.size === 0} onClick={synthesize}>
              <Check size={15} aria-hidden="true" /> Synthesize
            </button>
          </div>
        </form>
      </main>
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
  return (
    <aside className="chat-clusters" aria-label="Source clusters">
      <div className="chat-section-head">
        <h2>Source clusters</h2>
      </div>
      {visible.length === 0 ? (
        <p className="muted-copy">Clusters appear before synthesis.</p>
      ) : (
        visible.map((cluster) => (
          <button
            type="button"
            key={cluster.clusterId}
            className={`chat-cluster-item${accepted.has(cluster.clusterId) ? " is-accepted" : ""}`}
            onClick={() => onToggle(cluster.clusterId)}
          >
            <span className="chat-cluster-title">{cluster.title}</span>
            <span className="chat-cluster-kind">{cluster.sourceKind}</span>
            <span className="chat-cluster-summary">{cluster.summary}</span>
          </button>
        ))
      )}
    </aside>
  );
}
