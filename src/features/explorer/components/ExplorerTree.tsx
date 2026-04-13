import type { ExplorerNode } from "../types/explorer";
import { ExplorerRow } from "./ExplorerRow";

export function ExplorerTree({
  expandedIds,
  nodes,
  pendingInlineRenameId,
  onDelete,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename,
  onStartRename,
  selectedId
}: {
  expandedIds: string[];
  nodes: ExplorerNode[];
  pendingInlineRenameId: string | null;
  onDelete(nodeId: string, cascade: boolean): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
  onInlineRename(nodeId: string, newName: string): void;
  onStartRename(nodeId: string): void;
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
          pendingInlineRenameId={pendingInlineRenameId}
          onDelete={onDelete}
          onRetry={onRetry}
          onSelect={onSelect}
          onToggle={onToggle}
          onInlineRename={onInlineRename}
          onStartRename={onStartRename}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}

function TreeBranch({
  expandedSet,
  node,
  pendingInlineRenameId,
  onDelete,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename,
  onStartRename,
  selectedId,
  depth = 0
}: {
  expandedSet: Set<string>;
  node: ExplorerNode;
  pendingInlineRenameId: string | null;
  onDelete(nodeId: string, cascade: boolean): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
  onInlineRename(nodeId: string, newName: string): void;
  onStartRename(nodeId: string): void;
  selectedId: string | null;
  depth?: number;
}) {
  const isExpanded = expandedSet.has(node.id);

  return (
    <div className="tree-branch">
      <ExplorerRow
        depth={depth}
        isExpanded={isExpanded}
        isInlineRenaming={node.id === pendingInlineRenameId}
        isSelected={selectedId === node.id}
        node={node}
        onDelete={onDelete}
        onInlineRename={onInlineRename}
        onRetry={onRetry}
        onSelect={onSelect}
        onStartRename={onStartRename}
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
              pendingInlineRenameId={pendingInlineRenameId}
              onDelete={onDelete}
              onRetry={onRetry}
              onSelect={onSelect}
              onToggle={onToggle}
              onInlineRename={onInlineRename}
              onStartRename={onStartRename}
              selectedId={selectedId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
