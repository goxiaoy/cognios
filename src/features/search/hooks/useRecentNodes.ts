import { useMemo } from "react";
import { useExplorerStoreContext } from "../../explorer/store/ExplorerStoreContext";
import type { ExplorerNode } from "../../explorer/types/explorer";

export const RECENT_NODES_LIMIT = 10;

const ACTIVATABLE_KINDS = new Set([
  "note",
  "file",
  "url",
  "folder",
  "mount",
]);

/**
 * Top-N nodes from the explorer snapshot, ordered by most-recent
 * `modifiedAt`. Powers the Cmd+K palette's "before-you-type" empty
 * state — a quick-jump list that matches the "find a known node"
 * primary use case better than a blank pane.
 *
 * Walks the snapshot tree depth-first. Containers (folders, mounts)
 * are included alongside leaf kinds so a recently-touched folder is
 * reachable from the palette.
 */
export function useRecentNodes(limit: number = RECENT_NODES_LIMIT): ExplorerNode[] {
  const store = useExplorerStoreContext();
  return useMemo(() => collectRecent(store.snapshot.roots, limit), [store.snapshot, limit]);
}

function collectRecent(roots: ExplorerNode[], limit: number): ExplorerNode[] {
  const all: ExplorerNode[] = [];
  walk(roots, all);
  return all
    .filter((node) => ACTIVATABLE_KINDS.has(node.kind))
    .sort((a, b) => modifiedTimeMs(b) - modifiedTimeMs(a))
    .slice(0, limit);
}

function walk(nodes: ExplorerNode[], out: ExplorerNode[]): void {
  for (const node of nodes) {
    out.push(node);
    if (node.children?.length) {
      walk(node.children, out);
    }
  }
}

function modifiedTimeMs(node: ExplorerNode): number {
  const value = node.modifiedAt ?? node.createdAt;
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}
