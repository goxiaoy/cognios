import { useCallback, useMemo, useState } from "react";
import { error as logError } from "../../../lib/logger";
import type {
  ExplorerClient,
  ExplorerNode,
  ExplorerSnapshot,
  ExplorerViewMode
} from "../types/explorer";

const EMPTY_SNAPSHOT: ExplorerSnapshot = { roots: [] };

export function useExplorerStore(client: ExplorerClient) {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot>(EMPTY_SNAPSHOT);
  const [displayedFolderId, setDisplayedFolderId] = useState<string | null>(null);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ExplorerViewMode>("grid");
  const [isHierarchyCollapsed, setIsHierarchyCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<
    "folder" | "mount" | "url" | "rename" | "delete" | "retry" | null
  >(null);
  const [pendingInlineRenameId, setPendingInlineRenameId] = useState<string | null>(null);

  const nodeIndex = useMemo(() => indexNodes(snapshot.roots), [snapshot]);
  const displayedFolder = displayedFolderId
    ? asDisplayFolder(nodeIndex.get(displayedFolderId) ?? null)
    : null;
  const visibleArtifacts = displayedFolder ? displayedFolder.children : snapshot.roots;
  const breadcrumbs = displayedFolderId
    ? buildBreadcrumbs(displayedFolderId, nodeIndex)
    : [];
  const selectedArtifacts = selectedArtifactIds
    .map((id) => nodeIndex.get(id) ?? null)
    .filter((node): node is ExplorerNode => node !== null);
  const selectionCount = selectedArtifacts.length;
  const inspectorNode = selectionCount === 1 ? selectedArtifacts[0] : null;
  const mutationTarget = selectionCount <= 1 ? inspectorNode : null;

  const applySnapshot = useCallback(
    (nextSnapshot: ExplorerSnapshot) => {
      const nextIndex = indexNodes(nextSnapshot.roots);
      const nextDisplayedFolderId =
        displayedFolderId && isDisplayFolder(nextIndex.get(displayedFolderId) ?? null)
          ? displayedFolderId
          : null;

      setSnapshot(nextSnapshot);
      setExpandedIds((current) => {
        const next = new Set(current);
        for (const root of nextSnapshot.roots) {
          next.add(root.id);
        }
        if (nextDisplayedFolderId) {
          for (const ancestorId of collectAncestorIds(nextDisplayedFolderId, nextIndex)) {
            next.add(ancestorId);
          }
        }
        return [...next];
      });
      setDisplayedFolderId(nextDisplayedFolderId);
      setSelectedArtifactIds((current) =>
        current.filter((id) => {
          const node = nextIndex.get(id);
          if (!node) return false;
          const parentId = node.parentId ?? null;
          return parentId === nextDisplayedFolderId;
        })
      );
    },
    [displayedFolderId]
  );

  const refresh = useCallback(async () => {
    const nextSnapshot = await client.getExplorerSnapshot();
    applySnapshot(nextSnapshot);
  }, [applySnapshot, client]);

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

  const selectDisplayedFolder = useCallback(
    (nodeId: string | null) => {
      setDisplayedFolderId(nodeId);
      setSelectedArtifactIds([]);
      if (!nodeId) return;
      setExpandedIds((current) => {
        const next = new Set(current);
        for (const ancestorId of collectAncestorIds(nodeId, nodeIndex)) {
          next.add(ancestorId);
        }
        return [...next];
      });
    },
    [nodeIndex]
  );

  const selectTreeNode = useCallback(
    (nodeId: string) => {
      const node = nodeIndex.get(nodeId) ?? null;
      if (!node) return;

      if (isDisplayFolder(node)) {
        selectDisplayedFolder(node.id);
        return;
      }

      setDisplayedFolderId(node.parentId);
      setSelectedArtifactIds([node.id]);
      setExpandedIds((current) => {
        const next = new Set(current);
        for (const ancestorId of collectAncestorIds(node.id, nodeIndex)) {
          next.add(ancestorId);
        }
        return [...next];
      });
    },
    [nodeIndex, selectDisplayedFolder]
  );

  const selectArtifact = useCallback(
    (nodeId: string, additive = false) => {
      if (!additive) {
        setSelectedArtifactIds([nodeId]);
        return;
      }

      setSelectedArtifactIds((current) => {
        if (current.includes(nodeId)) {
          return current.filter((id) => id !== nodeId);
        }
        return [...current, nodeId];
      });
    },
    []
  );

  const activateArtifact = useCallback(
    (nodeId: string) => {
      const node = nodeIndex.get(nodeId) ?? null;
      if (!node || !isDisplayFolder(node)) return;
      selectDisplayedFolder(node.id);
    },
    [nodeIndex, selectDisplayedFolder]
  );

  const toggleHierarchyCollapsed = useCallback(() => {
    setIsHierarchyCollapsed((current) => !current);
  }, []);

  const runAction = useCallback(
    async <T,>(
      action: NonNullable<typeof activeAction>,
      work: () => Promise<T>
    ): Promise<T | undefined> => {
      setActiveAction(action);
      setError(null);
      try {
        return await work();
      } catch (cause) {
        void logError(`[ExplorerStore] action "${action}" failed: ${formatError(cause)}`);
        setError(formatError(cause));
        return undefined;
      } finally {
        setActiveAction(null);
      }
    },
    []
  );

  return {
    snapshot,
    displayedFolderId,
    displayedFolder,
    visibleArtifacts,
    selectedArtifactIds,
    selectedArtifacts,
    selectionCount,
    expandedIds,
    breadcrumbs,
    inspectorNode,
    mutationTarget,
    isHierarchyCollapsed,
    viewMode,
    isLoading,
    error,
    activeAction,
    setIsLoading,
    setError,
    setViewMode,
    applySnapshot,
    refresh,
    toggleNode,
    selectTreeNode,
    selectDisplayedFolder,
    selectArtifact,
    activateArtifact,
    toggleHierarchyCollapsed,
    runAction,
    pendingInlineRenameId,
    setPendingInlineRenameId
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

function collectAncestorIds(nodeId: string, nodeIndex: Map<string, ExplorerNode>) {
  return buildBreadcrumbs(nodeId, nodeIndex).map((node) => node.id);
}

export function isDisplayFolder(node: ExplorerNode | null) {
  return (
    node !== null &&
    (node.kind === "folder" || node.kind === "mount" || node.kind === "directory")
  );
}

function asDisplayFolder(node: ExplorerNode | null) {
  return isDisplayFolder(node) ? node : null;
}

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unexpected backend error";
}
