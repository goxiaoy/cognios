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
    </div>
  );
}
