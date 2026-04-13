import type { ExplorerNode } from "../types/explorer";
import { ExplorerRow } from "./ExplorerRow";

export function ExplorerTree({
  expandedIds,
  nodes,
  onRetry,
  onSelect,
  onToggle,
  selectedId
}: {
  expandedIds: string[];
  nodes: ExplorerNode[];
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
  selectedId: string | null;
}) {
  const expandedSet = new Set(expandedIds);

  return (
    <div className="explorer-tree" role="tree">
      {nodes.map((node) => (
        <TreeBranch
          expandedSet={expandedSet}
          key={node.id}
          node={node}
          onRetry={onRetry}
          onSelect={onSelect}
          onToggle={onToggle}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}

function TreeBranch({
  expandedSet,
  node,
  onRetry,
  onSelect,
  onToggle,
  selectedId,
  depth = 0
}: {
  expandedSet: Set<string>;
  node: ExplorerNode;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
  selectedId: string | null;
  depth?: number;
}) {
  const isExpanded = expandedSet.has(node.id);

  return (
    <div className="tree-branch">
      <ExplorerRow
        depth={depth}
        isExpanded={isExpanded}
        isSelected={selectedId === node.id}
        node={node}
        onRetry={onRetry}
        onSelect={onSelect}
        onToggle={onToggle}
      />
      {isExpanded && node.children.length > 0 ? (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <TreeBranch
              depth={depth + 1}
              expandedSet={expandedSet}
              key={child.id}
              node={child}
              onRetry={onRetry}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedId={selectedId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
