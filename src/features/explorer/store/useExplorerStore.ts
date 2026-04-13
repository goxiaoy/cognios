import { useCallback, useMemo, useState } from "react";
import type { ExplorerClient, ExplorerNode, ExplorerSnapshot } from "../types/explorer";

const EMPTY_SNAPSHOT: ExplorerSnapshot = { roots: [] };

export function useExplorerStore(client: ExplorerClient) {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot>(EMPTY_SNAPSHOT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<"folder" | "mount" | "url" | "rename" | "delete" | "retry" | null>(null);

  const nodeIndex = useMemo(() => indexNodes(snapshot.roots), [snapshot]);
  const selectedNode = selectedId ? nodeIndex.get(selectedId) ?? null : null;
  const breadcrumbs = selectedId ? buildBreadcrumbs(selectedId, nodeIndex) : [];

  const refresh = useCallback(async () => {
    const nextSnapshot = await client.getExplorerSnapshot();
    applySnapshot(nextSnapshot);
  }, [client]);

  const applySnapshot = useCallback((nextSnapshot: ExplorerSnapshot) => {
    setSnapshot(nextSnapshot);
    setExpandedIds((current) => {
      const next = new Set(current);
      for (const root of nextSnapshot.roots) {
        next.add(root.id);
      }
      return [...next];
    });
    setSelectedId((current) => {
      if (!current) {
        return nextSnapshot.roots[0]?.id ?? null;
      }
      return indexNodes(nextSnapshot.roots).has(current)
        ? current
        : nextSnapshot.roots[0]?.id ?? null;
    });
  }, []);

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return [...next];
    });
  }, []);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedId(nodeId);
    setExpandedIds((current) => {
      if (current.includes(nodeId)) {
        return current;
      }
      return [...current, nodeId];
    });
  }, []);

  const runAction = useCallback(async <T,>(
    action: NonNullable<typeof activeAction>,
    work: () => Promise<T>
  ): Promise<T | undefined> => {
    setActiveAction(action);
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(formatError(cause));
      return undefined;
    } finally {
      setActiveAction(null);
    }
  }, []);

  return {
    snapshot,
    selectedId,
    selectedNode,
    expandedIds,
    breadcrumbs,
    isLoading,
    error,
    activeAction,
    setIsLoading,
    setError,
    applySnapshot,
    refresh,
    toggleNode,
    selectNode,
    runAction
  };
}

function indexNodes(roots: ExplorerNode[]): Map<string, ExplorerNode> {
  const index = new Map<string, ExplorerNode>();

  function visit(node: ExplorerNode) {
    index.set(node.id, node);
    for (const child of node.children) {
      visit(child);
    }
  }

  for (const root of roots) {
    visit(root);
  }

  return index;
}

function buildBreadcrumbs(nodeId: string, nodeIndex: Map<string, ExplorerNode>) {
  const path: ExplorerNode[] = [];
  let cursor = nodeIndex.get(nodeId) ?? null;

  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? nodeIndex.get(cursor.parentId) ?? null : null;
  }

  return path;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unexpected backend error";
}
