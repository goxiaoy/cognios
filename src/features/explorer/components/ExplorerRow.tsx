import type { ExplorerNode } from "../types/explorer";

export function ExplorerRow({
  node,
  depth,
  isExpanded,
  isSelected,
  onRetry,
  onSelect,
  onToggle
}: {
  node: ExplorerNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
}) {
  const hasChildren = node.children.length > 0;

  return (
    <div
      className={`tree-row${isSelected ? " is-selected" : ""}`}
      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
    >
      <button
        aria-label={hasChildren ? (isExpanded ? "Collapse node" : "Expand node") : "Leaf node"}
        className="tree-expander"
        disabled={!hasChildren}
        onClick={() => hasChildren && onToggle(node.id)}
        type="button"
      >
        {hasChildren ? (isExpanded ? "−" : "+") : "·"}
      </button>
      <button
        className="tree-row-main"
        onClick={() => onSelect(node.id)}
        type="button"
      >
        <span className="node-kind">{node.kind}</span>
        <span className="node-name">{node.name}</span>
        <span className="node-state">{node.state}</span>
      </button>
      {node.kind === "url" && node.state === "error" ? (
        <button className="tree-inline-action" onClick={() => onRetry(node.id)} type="button">
          Retry
        </button>
      ) : null}
    </div>
  );
}
