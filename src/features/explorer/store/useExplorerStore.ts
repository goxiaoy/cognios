import { useCallback, useMemo, useState } from "react";
import { error as logError } from "../../../lib/logger";
import type {
  ExplorerClient,
  ExplorerNode,
  ExplorerSnapshot
} from "../types/explorer";
import { isImageNode, isMarkdownFile } from "../utils/presentation";

const EMPTY_SNAPSHOT: ExplorerSnapshot = { roots: [] };

export function useExplorerStore(client: ExplorerClient) {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot>(EMPTY_SNAPSHOT);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<
    "folder" | "mount" | "url" | "note" | "rename" | "delete" | "retry" | null
  >(null);
  const [pendingInlineRenameId, setPendingInlineRenameId] = useState<string | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [activeImagePreviewId, setActiveImagePreviewId] = useState<string | null>(null);
  // Dedicated search view (Cmd+Shift+F). Holds the seed query the
  // palette carried in via "More results", or "" when opened directly
  // by the shortcut. ``null`` means the view is closed and the center
  // pane shows file/note/image surfaces as usual.
  const [activeSearchView, setActiveSearchViewState] = useState<
    { initialQuery: string } | null
  >(null);

  const nodeIndex = useMemo(() => indexNodes(snapshot.roots), [snapshot]);
  const activeNote = activeNoteId ? (nodeIndex.get(activeNoteId) ?? null) : null;
  const activePreview = activePreviewId ? (nodeIndex.get(activePreviewId) ?? null) : null;
  const activeImagePreview = activeImagePreviewId
    ? (nodeIndex.get(activeImagePreviewId) ?? null)
    : null;
  const selectedArtifacts = selectedArtifactIds
    .map((id) => nodeIndex.get(id) ?? null)
    .filter((node): node is ExplorerNode => node !== null);
  const selectionCount = selectedArtifacts.length;
  const inspectorNode = selectionCount === 1 ? selectedArtifacts[0] : null;

  const applySnapshot = useCallback((nextSnapshot: ExplorerSnapshot) => {
    const nextIndex = indexNodes(nextSnapshot.roots);
    setSnapshot((prev) => {
      // Auto-expand only newly-added roots (or all roots on first non-empty
      // snapshot). Otherwise a user-collapsed root would re-open every time
      // another mutation triggers applySnapshot.
      const prevRootIds = new Set(prev.roots.map((root) => root.id));
      const isFirstSnapshot = prev.roots.length === 0;
      setExpandedIds((current) => {
        const next = new Set(current);
        for (const root of nextSnapshot.roots) {
          if (isFirstSnapshot || !prevRootIds.has(root.id)) {
            next.add(root.id);
          }
        }
        return [...next];
      });
      return nextSnapshot;
    });
    // Drop any selected ids whose nodes no longer exist after the snapshot
    // (covers external delete / mount unmount). Keep all others regardless of parent.
    setSelectedArtifactIds((current) => current.filter((id) => nextIndex.has(id)));
  }, []);

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

  const selectArtifact = useCallback((nodeId: string, additive = false) => {
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
  }, []);

  // Atomic batch setter for Shift-click range selection. Single dispatch.
  const replaceSelection = useCallback((ids: string[]) => {
    setSelectedArtifactIds(ids);
  }, []);

  // Single store entry point for "user activated a tree row".
  // Does not handle URL open-in-browser — that's a side effect for the layout
  // since it requires the shell plugin (out of scope for the store).
  const activateArtifact = useCallback(
    (nodeId: string) => {
      const node = nodeIndex.get(nodeId) ?? null;
      if (!node) return;

      // Activating any artifact takes the user back to the file
      // detail surface; close the dedicated search view if it was
      // open. Matches VS Code: opening a file from the tree leaves
      // search visible in the sidebar but returns the editor to
      // file content. Our center pane is single-purpose so closing
      // is the only option.
      setActiveSearchViewState(null);

      if (isDisplayFolder(node)) {
        // Container: toggle expansion. Selection update is the layout's
        // responsibility (handles modifiers); the store does not touch
        // selection here.
        toggleNode(node.id);
        return;
      }

      // Activate the appropriate center-pane surface based on node kind.
      // Selection is already handled by the layout before this call.
      if (node.kind === "note") {
        setActiveNoteId(node.id);
        return;
      }
      if (node.kind === "file") {
        if (isMarkdownFile(node)) {
          setActivePreviewId(node.id);
          return;
        }
        if (isImageNode(node)) {
          setActiveImagePreviewId(node.id);
          return;
        }
        // Other file kinds: no surface change; the layout shows the
        // "Cannot preview" placeholder via its own derivation.
      }
      // url, directory, mount were already handled or have no surface.
    },
    [nodeIndex, toggleNode]
  );

  const openSearchView = useCallback((initialQuery: string = "") => {
    setActiveSearchViewState({ initialQuery });
  }, []);

  const closeSearchView = useCallback(() => {
    setActiveSearchViewState(null);
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
    selectedArtifactIds,
    selectedArtifacts,
    selectionCount,
    expandedIds,
    inspectorNode,
    isLoading,
    error,
    activeAction,
    setIsLoading,
    setError,
    applySnapshot,
    refresh,
    toggleNode,
    selectArtifact,
    replaceSelection,
    activateArtifact,
    runAction,
    pendingInlineRenameId,
    setPendingInlineRenameId,
    activeNoteId,
    setActiveNoteId,
    activeNote,
    activePreviewId,
    setActivePreviewId,
    activePreview,
    activeImagePreviewId,
    setActiveImagePreviewId,
    activeImagePreview,
    activeSearchView,
    openSearchView,
    closeSearchView,
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

export function isDisplayFolder(node: ExplorerNode | null) {
  return (
    node !== null &&
    (node.kind === "folder" || node.kind === "mount" || node.kind === "directory")
  );
}

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unexpected backend error";
}
