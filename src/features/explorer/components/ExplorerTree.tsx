import type { ReactNode } from "react";
import type { NodeStatusView } from "../../../lib/contracts/nodeStatus";
import type { ExplorerNode } from "../types/explorer";
import { ExplorerRow, type SelectModifiers } from "./ExplorerRow";

interface ExplorerTreeProps {
  expandedIds: string[];
  nodes: ExplorerNode[];
  nodeStatuses?: Record<string, NodeStatusView>;
  pendingInlineRenameId: string | null;
  onDelete(nodeId: string, cascade: boolean): void;
  onDeleteMany(nodeIds: string[]): void;
  onOpenUrl(nodeId: string): void;
  onRevealInFileManager(nodeId: string): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string, modifiers: SelectModifiers): void;
  onToggle(nodeId: string): void;
  onInlineRename(nodeId: string, newName: string): void;
  onStartRename(nodeId: string): void;
  selectedIds: string[];
  toolbar?: ReactNode;
}

export function ExplorerTree({
  expandedIds,
  nodes,
  nodeStatuses = {},
  pendingInlineRenameId,
  onDelete,
  onDeleteMany,
  onOpenUrl,
  onRevealInFileManager,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename,
  onStartRename,
  selectedIds,
  toolbar
}: ExplorerTreeProps) {
  const expandedSet = new Set(expandedIds);
  const selectedSet = new Set(selectedIds);

  return (
    <div className="explorer-tree-container">
      {toolbar ? <div className="explorer-tree-toolbar">{toolbar}</div> : null}
      {nodes.length === 0 ? (
        <div className="explorer-tree-empty" role="status">
          Mount a folder or create a note to add your first node.
        </div>
      ) : (
        <div className="explorer-tree" role="tree">
          {nodes.map((node) => (
            <TreeBranch
              ancestorNodes={[]}
              expandedSet={expandedSet}
              key={node.id}
              node={node}
              nodeStatuses={nodeStatuses}
              pendingInlineRenameId={pendingInlineRenameId}
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              onOpenUrl={onOpenUrl}
              onRevealInFileManager={onRevealInFileManager}
              onRetry={onRetry}
              onSelect={onSelect}
              onToggle={onToggle}
              onInlineRename={onInlineRename}
              onStartRename={onStartRename}
              selectedSet={selectedSet}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeBranch({
  ancestorNodes,
  expandedSet,
  node,
  nodeStatuses,
  pendingInlineRenameId,
  onDelete,
  onDeleteMany,
  onOpenUrl,
  onRevealInFileManager,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename,
  onStartRename,
  selectedSet,
  depth = 0
}: {
  ancestorNodes: ExplorerNode[];
  expandedSet: Set<string>;
  node: ExplorerNode;
  nodeStatuses: Record<string, NodeStatusView>;
  pendingInlineRenameId: string | null;
  onDelete(nodeId: string, cascade: boolean): void;
  onDeleteMany(nodeIds: string[]): void;
  onOpenUrl(nodeId: string): void;
  onRevealInFileManager(nodeId: string): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string, modifiers: SelectModifiers): void;
  onToggle(nodeId: string): void;
  onInlineRename(nodeId: string, newName: string): void;
  onStartRename(nodeId: string): void;
  selectedSet: Set<string>;
  depth?: number;
}) {
  const isExpanded = expandedSet.has(node.id);
  const pathNodes = [...ancestorNodes, node];

  return (
    <div className="tree-branch">
      <ExplorerRow
        depth={depth}
        isExpanded={isExpanded}
        isInlineRenaming={node.id === pendingInlineRenameId}
        isSelected={selectedSet.has(node.id)}
        selectedIds={[...selectedSet]}
        node={node}
        nodeStatus={nodeStatuses[node.id] ?? null}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
        onOpenUrl={onOpenUrl}
        onRevealInFileManager={onRevealInFileManager}
        onInlineRename={onInlineRename}
        onRetry={onRetry}
        onSelect={onSelect}
        onStartRename={onStartRename}
        onToggle={onToggle}
        pathNodes={pathNodes}
      />
      {isExpanded && node.children.length > 0 ? (
        <div className="tree-children" role="group">
          {node.children.map((child) => (
            <TreeBranch
              ancestorNodes={pathNodes}
              depth={depth + 1}
              expandedSet={expandedSet}
              key={child.id}
              node={child}
              nodeStatuses={nodeStatuses}
              pendingInlineRenameId={pendingInlineRenameId}
              onDelete={onDelete}
              onDeleteMany={onDeleteMany}
              onOpenUrl={onOpenUrl}
              onRevealInFileManager={onRevealInFileManager}
              onRetry={onRetry}
              onSelect={onSelect}
              onToggle={onToggle}
              onInlineRename={onInlineRename}
              onStartRename={onStartRename}
              selectedSet={selectedSet}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
