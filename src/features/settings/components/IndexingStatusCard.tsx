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

  const { indexedChunks } = envelope.data;
  const queuedCount = queuedJobs(envelope.data);
  const activeCount = activeJobs(envelope.data);
  const isIdle = queuedCount === 0 && activeCount === 0;
  const taskRows = envelope.data.tasks?.filter((task) => task.total > 0) ?? [];

  return (
    <div className="settings-card">
      <h2 className="settings-card-title">Indexing</h2>
      <dl className="settings-stat-grid">
        <div className="settings-stat">
          <dt>Queued jobs</dt>
          <dd>{queuedCount}</dd>
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
          Working through {queuedCount} pending {queuedCount === 1 ? "job" : "jobs"}.
        </p>
      )}
      {taskRows.length > 0 ? (
        <dl className="settings-stat-grid settings-stat-grid--compact">
          {taskRows.map((task) => (
            <div className="settings-stat" key={task.taskType}>
              <dt>{task.taskType}</dt>
              <dd>
                {task.running} running / {task.queued} queued
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function queuedJobs(status: IndexStatus): number {
  return status.taskTotals?.queued ?? 0;
}

function activeJobs(status: IndexStatus): number {
  return (
    status.taskTotals?.running ??
    status.inFlight.length + status.enhancementInFlight.length
  );
}
