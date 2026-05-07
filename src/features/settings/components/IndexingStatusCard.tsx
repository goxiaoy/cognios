import type {
  IndexStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";

export function IndexingStatusCard({
  envelope,
}: {
  envelope: SidecarEnvelope<IndexStatus> | null;
}) {
  if (envelope === null) {
    return (
      <div className="settings-card">
        <h2 className="settings-card-title">Indexing</h2>
        <p className="muted-copy">Loading…</p>
      </div>
    );
  }

  if (envelope.state !== "ready" || !envelope.data) {
    const message =
      envelope.state === "initialising"
        ? "Search subsystem is starting up…"
        : envelope.error ?? "Unable to reach the search subsystem.";
    return (
      <div className="settings-card">
        <h2 className="settings-card-title">Indexing</h2>
        <p className="muted-copy">{message}</p>
      </div>
    );
  }

  const { queueDepth, inFlight, enhancementInFlight, indexedChunks } =
    envelope.data;
  const activeCount = inFlight.length + enhancementInFlight.length;
  const isIdle = queueDepth === 0 && activeCount === 0;

  return (
    <div className="settings-card">
      <h2 className="settings-card-title">Indexing</h2>
      <dl className="settings-stat-grid">
        <div className="settings-stat">
          <dt>Queue depth</dt>
          <dd>{queueDepth}</dd>
        </div>
        <div className="settings-stat">
          <dt>In flight</dt>
          <dd>{activeCount}</dd>
        </div>
        <div className="settings-stat">
          <dt>Indexed chunks</dt>
          <dd>{indexedChunks}</dd>
        </div>
      </dl>
      {isIdle ? (
        <p className="muted-copy settings-card-hint">Indexer is idle.</p>
      ) : (
        <p className="muted-copy settings-card-hint">
          Working through {queueDepth} pending {queueDepth === 1 ? "node" : "nodes"}.
        </p>
      )}
    </div>
  );
}
