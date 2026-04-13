import type { ExplorerNode } from "../types/explorer";

export function Breadcrumbs({
  nodes,
  onSelect
}: {
  nodes: ExplorerNode[];
  onSelect(nodeId: string): void;
}) {
  if (nodes.length === 0) {
    return <p className="breadcrumbs-empty">Select a node to inspect its path.</p>;
  }

  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      {nodes.map((node, index) => (
        <button
          className="breadcrumb-link"
          key={node.id}
          onClick={() => onSelect(node.id)}
          type="button"
        >
          {node.name}
          {index < nodes.length - 1 ? <span className="breadcrumb-separator">/</span> : null}
        </button>
      ))}
    </nav>
  );
}
