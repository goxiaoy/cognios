import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  BookOpen,
  Check,
  Clock3,
  GitBranch,
  ListChecks,
  RefreshCw,
  X,
} from "lucide-react";

import type {
  TopicMemory,
  TopicMemoryCitation,
  TopicMemoryDetail,
  TopicMemoryItem,
  TopicMemoryProposal,
  TopicMemoryRelationship,
  TopicMemorySource,
} from "../../../lib/contracts/topicMemory";
import { unwrapEnvelope } from "../../../lib/contracts/search";
import type { TopicMemoryClient } from "../api/topicMemoryClient";

type TopicView = "dossier" | "timeline" | "graph" | "review";

export function TopicMemoryLayout({
  client,
  visible = true,
  onActivateSource,
}: {
  client: TopicMemoryClient;
  visible?: boolean;
  onActivateSource?: (nodeId: string) => void;
}) {
  const [topics, setTopics] = useState<TopicMemory[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TopicMemoryDetail | null>(null);
  const [activeView, setActiveView] = useState<TopicView>("dossier");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actingProposalId, setActingProposalId] = useState<string | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    void loadTopics();
  }, [visible]);

  useEffect(() => {
    if (!selectedTopicId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedTopicId);
  }, [selectedTopicId]);

  const activeTopic = detail?.topic ?? topics.find((topic) => topic.id === selectedTopicId) ?? null;
  const topicStats = useMemo(() => summarizeTopic(detail), [detail]);

  async function loadTopics(preferredTopicId?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const next = await client.list();
      setTopics(next);
      const nextSelected =
        preferredTopicId ??
        selectedTopicId ??
        next.find((topic) => topic.status === "active")?.id ??
        next[0]?.id ??
        null;
      setSelectedTopicId(next.some((topic) => topic.id === nextSelected) ? nextSelected : next[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(topicId: string) {
    setError(null);
    try {
      setDetail(await client.get({ topicId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    }
  }

  async function refreshTopics() {
    setRefreshing(true);
    setRefreshStatus(null);
    setError(null);
    try {
      const envelope = await client.refresh();
      const result = unwrapEnvelope(envelope);
      if (!result) {
        setRefreshStatus(envelope.error ?? "Topic Memory worker is still starting.");
        return;
      }
      setRefreshStatus(
        `${result.topicsCreated} new, ${result.topicsUpdated} updated, ${result.sourcesApplied} sources, ${result.proposalsCreated} review items`
      );
      await loadTopics(selectedTopicId);
      if (selectedTopicId) await loadDetail(selectedTopicId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function acceptProposal(proposal: TopicMemoryProposal) {
    setActingProposalId(proposal.id);
    setError(null);
    try {
      const next = await client.acceptProposal({ proposalId: proposal.id });
      setDetail(next);
      await loadTopics(next.topic.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingProposalId(null);
    }
  }

  async function dismissProposal(proposal: TopicMemoryProposal) {
    setActingProposalId(proposal.id);
    setError(null);
    try {
      const dismissed = await client.dismissProposal({ proposalId: proposal.id });
      if (!dismissed) {
        setError("Proposal was not dismissed.");
        return;
      }
      if (selectedTopicId) await loadDetail(selectedTopicId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActingProposalId(null);
    }
  }

  async function archiveCurrentTopic() {
    if (!selectedTopicId) return;
    setError(null);
    try {
      await client.archive({ topicId: selectedTopicId });
      setDetail(null);
      setSelectedTopicId(null);
      await loadTopics(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="topic-memory-layout" aria-label="Topic Memory">
      <aside className="topic-memory-sidebar" aria-label="Topics">
        <header className="topic-memory-sidebar-head">
          <div>
            <p className="topic-memory-kicker">Topics</p>
            <h2>Memory Layer</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh Topic Memory"
            disabled={refreshing}
            onClick={() => void refreshTopics()}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </header>

        {refreshStatus ? <p className="topic-memory-status">{refreshStatus}</p> : null}
        {loading ? <p className="topic-memory-muted">Loading topics...</p> : null}

        <div className="topic-memory-list">
          {topics.map((topic) => (
            <button
              type="button"
              key={topic.id}
              className={`topic-memory-list-item${topic.id === selectedTopicId ? " is-active" : ""}`}
              onClick={() => setSelectedTopicId(topic.id)}
            >
              <span>{topic.title}</span>
              <small>{Math.round(topic.confidence * 100)}% confidence</small>
            </button>
          ))}
          {!loading && topics.length === 0 ? (
            <div className="topic-memory-empty">
              <BookOpen size={18} aria-hidden="true" />
              <p>Refresh to discover topics across indexed notes, folders, voice notes, and mounted vaults.</p>
            </div>
          ) : null}
        </div>
      </aside>

      <main className="topic-memory-main">
        <header className="topic-memory-header">
          <div className="topic-memory-title-block">
            <p className="topic-memory-kicker">Canonical topic memory</p>
            <h2>{activeTopic?.title ?? "No topic selected"}</h2>
            {activeTopic ? <p>{activeTopic.summary}</p> : null}
          </div>
          <div className="topic-memory-actions">
            <button
              type="button"
              className="topic-memory-secondary-action"
              disabled={!activeTopic}
              onClick={() => void archiveCurrentTopic()}
            >
              <Archive size={15} aria-hidden="true" />
              Archive
            </button>
            <button
              type="button"
              className="topic-memory-primary-action"
              disabled={refreshing}
              onClick={() => void refreshTopics()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </header>

        {error ? <p className="topic-memory-error" role="status">{error}</p> : null}

        <div className="topic-memory-tabs" role="tablist" aria-label="Topic views">
          <TopicTab view="dossier" activeView={activeView} onSelect={setActiveView} icon={<BookOpen size={14} />} label="Dossier" />
          <TopicTab view="timeline" activeView={activeView} onSelect={setActiveView} icon={<Clock3 size={14} />} label="Timeline" />
          <TopicTab view="graph" activeView={activeView} onSelect={setActiveView} icon={<GitBranch size={14} />} label="Graph" />
          <TopicTab view="review" activeView={activeView} onSelect={setActiveView} icon={<ListChecks size={14} />} label={`Review ${detail?.proposals.length ? `(${detail.proposals.length})` : ""}`} />
        </div>

        {detail ? (
          <div className="topic-memory-content">
            <section className="topic-memory-stat-strip" aria-label="Topic summary">
              <Stat label="Sources" value={topicStats.sourceCount} />
              <Stat label="Claims" value={topicStats.claimCount} />
              <Stat label="Events" value={topicStats.eventCount} />
              <Stat label="Relations" value={topicStats.relationshipCount} />
            </section>

            {activeView === "dossier" ? (
              <DossierView detail={detail} onActivateSource={onActivateSource} />
            ) : null}
            {activeView === "timeline" ? (
              <TimelineView items={detail.items} onActivateSource={onActivateSource} />
            ) : null}
            {activeView === "graph" ? (
              <GraphView relationships={detail.relationships} />
            ) : null}
            {activeView === "review" ? (
              <ReviewView
                proposals={detail.proposals}
                actingProposalId={actingProposalId}
                onAccept={acceptProposal}
                onDismiss={dismissProposal}
              />
            ) : null}
          </div>
        ) : (
          <div className="topic-memory-content topic-memory-content-empty">
            <BookOpen size={22} aria-hidden="true" />
            <p>Topic Memory has no selected dossier yet.</p>
          </div>
        )}
      </main>
    </section>
  );
}

function TopicTab({
  view,
  activeView,
  onSelect,
  icon,
  label,
}: {
  view: TopicView;
  activeView: TopicView;
  onSelect(view: TopicView): void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activeView === view}
      className={`topic-memory-tab${activeView === view ? " is-active" : ""}`}
      onClick={() => onSelect(view)}
    >
      {icon}
      {label}
    </button>
  );
}

function DossierView({
  detail,
  onActivateSource,
}: {
  detail: TopicMemoryDetail;
  onActivateSource?: (nodeId: string) => void;
}) {
  const claims = detail.items.filter((item) => item.itemType === "claim");

  return (
    <div className="topic-memory-view">
      <section className="topic-memory-section">
        <h3>Claims</h3>
        <div className="topic-memory-item-list">
          {claims.map((item) => (
            <MemoryItemRow key={item.id} item={item} onActivateSource={onActivateSource} />
          ))}
          {claims.length === 0 ? <p className="topic-memory-muted">Accepted claims will appear here.</p> : null}
        </div>
      </section>
      <section className="topic-memory-section">
        <h3>Sources</h3>
        <div className="topic-memory-source-list">
          {detail.sources.map((source) => (
            <SourceRow key={source.id} source={source} onActivateSource={onActivateSource} />
          ))}
          {detail.sources.length === 0 ? <p className="topic-memory-muted">No source citations attached yet.</p> : null}
        </div>
      </section>
    </div>
  );
}

function TimelineView({
  items,
  onActivateSource,
}: {
  items: TopicMemoryItem[];
  onActivateSource?: (nodeId: string) => void;
}) {
  const events = items
    .filter((item) => item.itemType === "event")
    .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));

  return (
    <section className="topic-memory-section topic-memory-timeline">
      {events.map((item) => (
        <MemoryItemRow key={item.id} item={item} onActivateSource={onActivateSource} />
      ))}
      {events.length === 0 ? <p className="topic-memory-muted">Accepted events will form the timeline here.</p> : null}
    </section>
  );
}

function GraphView({ relationships }: { relationships: TopicMemoryRelationship[] }) {
  return (
    <section className="topic-memory-section">
      <h3>Relationships</h3>
      <div className="topic-memory-relationship-list">
        {relationships.map((relationship) => (
          <div className="topic-memory-relationship" key={relationship.id}>
            <strong>{relationship.sourceLabel}</strong>
            <span>{relationship.relationType.replaceAll("_", " ")}</span>
            <strong>{relationship.targetLabel}</strong>
            <small>{citationLabel(relationship.citation)}</small>
          </div>
        ))}
        {relationships.length === 0 ? <p className="topic-memory-muted">Accepted relationships will appear here.</p> : null}
      </div>
    </section>
  );
}

function ReviewView({
  proposals,
  actingProposalId,
  onAccept,
  onDismiss,
}: {
  proposals: TopicMemoryProposal[];
  actingProposalId: string | null;
  onAccept(proposal: TopicMemoryProposal): void;
  onDismiss(proposal: TopicMemoryProposal): void;
}) {
  return (
    <section className="topic-memory-section">
      <h3>Review Queue</h3>
      <div className="topic-memory-review-list">
        {proposals.map((proposal) => (
          <article className="topic-memory-review-item" key={proposal.id}>
            <div>
              <p className="topic-memory-review-type">{proposal.proposalType.replaceAll("_", " ")}</p>
              <h4>{proposal.title}</h4>
              <p>{proposal.rationale}</p>
              <small>{Math.round(proposal.confidence * 100)}% confidence</small>
            </div>
            <div className="topic-memory-review-actions">
              <button
                type="button"
                aria-label={`Accept ${proposal.title}`}
                disabled={actingProposalId === proposal.id}
                onClick={() => onAccept(proposal)}
              >
                <Check size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${proposal.title}`}
                disabled={actingProposalId === proposal.id}
                onClick={() => onDismiss(proposal)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </article>
        ))}
        {proposals.length === 0 ? <p className="topic-memory-muted">No pending high-impact memory proposals.</p> : null}
      </div>
    </section>
  );
}

function MemoryItemRow({
  item,
  onActivateSource,
}: {
  item: TopicMemoryItem;
  onActivateSource?: (nodeId: string) => void;
}) {
  return (
    <article className="topic-memory-item">
      <header>
        <h4>{item.title}</h4>
        {item.occurredAt ? <time>{item.occurredAt}</time> : null}
      </header>
      <p>{item.body}</p>
      <CitationButton citation={item.citation} onActivateSource={onActivateSource} />
    </article>
  );
}

function SourceRow({
  source,
  onActivateSource,
}: {
  source: TopicMemorySource;
  onActivateSource?: (nodeId: string) => void;
}) {
  return (
    <article className="topic-memory-source">
      <div>
        <h4>{source.nodeTitle}</h4>
        <p>{source.anchorLabel ?? source.path ?? source.nodeKind}</p>
      </div>
      <CitationButton citation={source.citation} onActivateSource={onActivateSource} />
    </article>
  );
}

function CitationButton({
  citation,
  onActivateSource,
}: {
  citation: TopicMemoryCitation;
  onActivateSource?: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="topic-memory-citation"
      disabled={!citation.nodeId}
      title={citation.path ?? citation.anchorLabel ?? citation.nodeId}
      onClick={() => citation.nodeId && onActivateSource?.(citation.nodeId)}
    >
      {citationLabel(citation)}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="topic-memory-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function summarizeTopic(detail: TopicMemoryDetail | null) {
  return {
    sourceCount: detail?.sources.length ?? 0,
    claimCount: detail?.items.filter((item) => item.itemType === "claim").length ?? 0,
    eventCount: detail?.items.filter((item) => item.itemType === "event").length ?? 0,
    relationshipCount: detail?.relationships.length ?? 0,
  };
}

function citationLabel(citation: TopicMemoryCitation): string {
  const parts = [
    citation.anchorLabel,
    citation.page ? `p.${citation.page}` : null,
    citation.timestampMs ? formatTimestamp(citation.timestampMs) : null,
    citation.chunkRole,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Source";
}

function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
