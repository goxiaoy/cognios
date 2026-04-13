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
      new Set(selectedArtifacts.map((artifact) => formatNodeKindLabel(artifact))).size === 1
        ? formatNodeKindLabel(selectedArtifacts[0])
        : "Mixed";
    const combinedSize = selectedArtifacts.reduce(
      (total, artifact) => total + artifact.sizeBytes,
      0
    );

    return (
      <section className="inspector-block">
        <header className="inspector-block-header">
          <p className="eyebrow">Inspector</p>
          <h3>{selectionCount} selected</h3>
        </header>
        <dl className="detail-grid">
          <div>
            <dt>Common type</dt>
            <dd>{commonType}</dd>
          </div>
          <div>
            <dt>Combined size</dt>
            <dd>{formatNodeSize(combinedSize)}</dd>
          </div>
        </dl>
      </section>
    );
  }

  if (!node) {
    return (
      <section className="inspector-block">
        <header className="inspector-block-header">
          <p className="eyebrow">Inspector</p>
          <h3>No selection</h3>
        </header>
        <p className="muted-copy">
          Select a folder in the hierarchy or an artifact in the grid to inspect its metadata.
        </p>
      </section>
    );
  }

  return (
    <section className="inspector-block">
      <header className="inspector-block-header">
        <p className="eyebrow">Inspector</p>
        <h3>{node.name}</h3>
        <p className="muted-copy">{formatInspectorKindLabel(node)}</p>
      </header>
      <dl className="detail-grid">
        <div>
          <dt>Created</dt>
          <dd>{formatNodeDate(node.createdAt)}</dd>
        </div>
        <div>
          <dt>Modified</dt>
          <dd>{formatNodeDate(node.modifiedAt)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatNodeSize(node.sizeBytes)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{node.state}</dd>
        </div>
      </dl>
    </section>
  );
}
