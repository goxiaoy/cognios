import { useMemo } from "react";
import { House } from "lucide-react";
import type { ExplorerNode, ExplorerViewMode } from "../types/explorer";
import { dateBucketLabel } from "../utils/presentation";
import { ArtifactCard } from "./ArtifactCard";
import { CreateMenu, type CreateAction } from "./CreateMenu";
import { ViewModeToggle } from "./ViewModeToggle";

export function ExplorerContentGrid({
  breadcrumbs,
  loadThumbnail,
  nodes,
  selectedIds,
  selectionCount,
  viewMode,
  pendingInlineRenameId,
  onActivate,
  onBreadcrumbSelect,
  onCreateSelect,
  onDelete,
  onInlineRename,
  onRetry,
  onSelect,
  onStartRename,
  onViewModeChange
}: {
  breadcrumbs: ExplorerNode[];
  loadThumbnail(nodeId: string): Promise<string>;
  nodes: ExplorerNode[];
  selectedIds: string[];
  selectionCount: number;
  viewMode: ExplorerViewMode;
  pendingInlineRenameId: string | null;
  onActivate(nodeId: string): void;
  onBreadcrumbSelect(nodeId: string | null): void;
  onCreateSelect(action: CreateAction): void;
  onDelete(nodeId: string, cascade: boolean): void;
  onInlineRename(nodeId: string, newName: string): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string, additive: boolean): void;
  onStartRename(nodeId: string): void;
  onViewModeChange(mode: ExplorerViewMode): void;
}) {
  const sortedNodes = useMemo(
    () => [...nodes].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    ),
    [nodes]
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const groupedByDate = useMemo(() => groupByDate(sortedNodes), [sortedNodes]);

  const currentName = breadcrumbs.length > 0
    ? breadcrumbs[breadcrumbs.length - 1].name
    : "Workspace";
  const ancestors = breadcrumbs.slice(0, -1);
  const fullPath = breadcrumbs.length > 0
    ? breadcrumbs.map((n) => n.name).join(" / ")
    : "Workspace";

  return (
    <section className="content-panel">
      <header className="content-header">
        <nav aria-label="Location" className="content-nav">
          <button
            aria-label="Go to workspace root"
            className="content-nav-home"
            onClick={() => onBreadcrumbSelect(null)}
            title={fullPath}
            type="button"
          >
            <House size={13} aria-hidden="true" />
          </button>
          {ancestors.map((node) => (
            <span key={node.id} className="content-nav-crumb">
              <span className="content-nav-sep">/</span>
              <button
                className="content-nav-ancestor"
                onClick={() => onBreadcrumbSelect(node.id)}
                type="button"
              >
                {node.name}
              </button>
            </span>
          ))}
          {breadcrumbs.length > 0 ? (
            <span className="content-nav-crumb">
              <span className="content-nav-sep">/</span>
            </span>
          ) : null}
          <h2 className="content-nav-title">{currentName}</h2>
        </nav>
        <div className="content-header-actions">
          <CreateMenu onSelect={onCreateSelect} />
          <ViewModeToggle onChange={onViewModeChange} value={viewMode} />
        </div>
      </header>

      {sortedNodes.length === 0 ? (
        <p className="empty-state">
          This folder has no visible artifacts yet.
        </p>
      ) : null}

      {sortedNodes.length > 0 && viewMode !== "date" ? (
        <div className={`artifact-collection artifact-collection-${viewMode}`}>
          {sortedNodes.map((node) => (
            <ArtifactCard
              key={node.id}
              isRenaming={node.id === pendingInlineRenameId}
              loadThumbnail={loadThumbnail}
              mode={viewMode}
              node={node}
              onActivate={onActivate}
              onDelete={onDelete}
              onInlineRename={onInlineRename}
              onRetry={onRetry}
              onSelect={onSelect}
              onStartRename={onStartRename}
              selected={selectedSet.has(node.id)}
            />
          ))}
        </div>
      ) : null}

      {sortedNodes.length > 0 && viewMode === "date" ? (
        <div className="date-groups">
          {groupedByDate.map(([label, group]) => (
            <section className="date-group" key={label}>
              <h4>{label}</h4>
              <div className="artifact-collection artifact-collection-grid">
                {group.map((node) => (
                  <ArtifactCard
                    key={node.id}
                    isRenaming={node.id === pendingInlineRenameId}
                    loadThumbnail={loadThumbnail}
                    mode="grid"
                    node={node}
                    onActivate={onActivate}
                    onDelete={onDelete}
                    onInlineRename={onInlineRename}
                    onRetry={onRetry}
                    onSelect={onSelect}
                    onStartRename={onStartRename}
                    selected={selectedSet.has(node.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {sortedNodes.length > 0 ? (
        <p className="content-total">{sortedNodes.length} items</p>
      ) : null}
    </section>
  );
}

function groupByDate(nodes: ExplorerNode[]) {
  const groups = new Map<string, ExplorerNode[]>();

  for (const node of nodes) {
    const label = dateBucketLabel(node.modifiedAt);
    const current = groups.get(label) ?? [];
    current.push(node);
    groups.set(label, current);
  }

  return ["Today", "Yesterday", "This Week", "Earlier"]
    .filter((label) => groups.has(label))
    .map((label) => [label, groups.get(label)!] as const);
}
