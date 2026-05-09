import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { ExplorerClient, ExplorerNode } from "../types/explorer";
import {
  formatInspectorKindLabel,
  formatNodeDate,
  formatNodeSize,
  formatNodeKindLabel,
  isImageNode,
} from "../utils/presentation";
import { InspectorImageThumbnail } from "./InspectorImageThumbnail";
import { NodeStateDot, resolveNodeStateTone } from "./NodeStateDot";

export function ExplorerInspector({
  node,
  selectedArtifacts,
  selectionCount,
  client,
}: {
  node: ExplorerNode | null;
  selectedArtifacts: ExplorerNode[];
  selectionCount: number;
  client: ExplorerClient;
}) {
  if (selectionCount > 1) {
    const commonType =
      new Set(selectedArtifacts.map((a) => formatNodeKindLabel(a))).size === 1
        ? formatNodeKindLabel(selectedArtifacts[0])
        : "Mixed";
    const combinedSize = selectedArtifacts.reduce((sum, a) => sum + a.sizeBytes, 0);

    return (
      <div className="inspector-pane">
        <div className="inspector-pane-header">
          <p className="inspector-pane-title">{selectionCount} items</p>
          <p className="inspector-pane-kind">Multiple selection</p>
        </div>
        <dl className="inspector-meta">
          <div className="inspector-meta-row">
            <dt>Type</dt>
            <dd>{commonType}</dd>
          </div>
          <div className="inspector-meta-row">
            <dt>Total size</dt>
            <dd>{formatNodeSize(combinedSize)}</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="inspector-pane inspector-pane--empty">
        <p className="inspector-empty-hint">No selection</p>
      </div>
    );
  }

  const showImage = isImageNode(node);

  return (
    <div className="inspector-pane">
      <div className="inspector-pane-header">
        <p className="inspector-pane-title" title={node.name}>{node.name}</p>
        <p className="inspector-pane-kind">{formatInspectorKindLabel(node)}</p>
      </div>
      <dl className="inspector-meta">
        <div className="inspector-meta-row">
          <dt>Created</dt>
          <dd>{formatNodeDate(node.createdAt)}</dd>
        </div>
        <div className="inspector-meta-row">
          <dt>Modified</dt>
          <dd>{formatNodeDate(node.modifiedAt)}</dd>
        </div>
        <div className="inspector-meta-row">
          <dt>Size</dt>
          <dd>{formatNodeSize(node.sizeBytes)}</dd>
        </div>
        <div className="inspector-meta-row">
          <dt>State</dt>
          <dd>
            {resolveNodeStateTone(node.kind, node.state) ? (
              <NodeStateDot kind={node.kind} state={node.state} withLabel />
            ) : (
              <span className="inspector-meta-muted">—</span>
            )}
          </dd>
        </div>
      </dl>
      {showImage ? (
        <InspectorImageThumbnail
          client={client}
          nodeId={node.id}
          name={node.name}
        />
      ) : null}

      <InspectorActions client={client} node={node} />
    </div>
  );
}

/** Per-node action panel. Currently exposes a single "Reindex"
 * action; for containers (folder / mount) the action
 * fans out to every indexable descendant. */
function InspectorActions({
  client,
  node,
}: {
  client: ExplorerClient;
  node: ExplorerNode;
}) {
  type Status =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; enqueued: number }
    | { kind: "error"; message: string };
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Auto-clear the "done" toast after a couple seconds — leaving
  // it pinned makes the inspector feel sticky / unfinished. Errors
  // stay until the user acts again so they're not missed.
  useEffect(() => {
    if (status.kind !== "done") return;
    const timer = window.setTimeout(() => setStatus({ kind: "idle" }), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Reset transient state when the user picks a different node so a
  // success toast from a previous selection doesn't appear to apply
  // to the new one.
  useEffect(() => {
    setStatus({ kind: "idle" });
  }, [node.id]);

  async function handleReindex() {
    setStatus({ kind: "running" });
    try {
      const { enqueued } = await client.reindexNode({ nodeId: node.id });
      setStatus({ kind: "done", enqueued });
    } catch (cause) {
      setStatus({
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const isContainer = node.kind === "folder" || node.kind === "mount";
  const reindexLabel = isContainer ? "Reindex contents" : "Reindex";

  return (
    <section className="inspector-actions" aria-label="Actions">
      <h3 className="inspector-section-label">Actions</h3>
      <button
        type="button"
        className="inspector-action-button"
        onClick={() => void handleReindex()}
        disabled={status.kind === "running"}
      >
        <RefreshCw
          size={12}
          aria-hidden="true"
          className={
            status.kind === "running" ? "inspector-action-icon is-spinning" : "inspector-action-icon"
          }
        />
        {status.kind === "running" ? "Reindexing…" : reindexLabel}
      </button>
      {status.kind === "done" ? (
        <p className="inspector-action-status">
          {status.enqueued === 0
            ? "Nothing to reindex."
            : `Re-enqueued ${status.enqueued} node${status.enqueued === 1 ? "" : "s"}.`}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="inspector-action-status is-error">{status.message}</p>
      ) : null}
    </section>
  );
}
