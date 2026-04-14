import type { ExplorerNode } from "../types/explorer";
import {
  formatInspectorKindLabel,
  formatNodeDate,
  formatNodeSize,
  formatNodeKindLabel
} from "../utils/presentation";

export function ExplorerInspector({
  node,
  selectedArtifacts,
  selectionCount
}: {
  node: ExplorerNode | null;
  selectedArtifacts: ExplorerNode[];
  selectionCount: number;
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

  if (!node) return null;

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
          <dd>{node.state}</dd>
        </div>
      </dl>
    </div>
  );
}
