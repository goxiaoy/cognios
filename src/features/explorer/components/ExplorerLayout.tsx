import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { ExistingMount, ExplorerClient, ExplorerNode, MountSetupContext } from "../types/explorer";
import type { CreateAction } from "./CreateMenu";
import type { SelectModifiers } from "./ExplorerRow";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStore, isDisplayFolder } from "../store/useExplorerStore";
import { Breadcrumbs } from "./Breadcrumbs";
import { CreateMenu } from "./CreateMenu";
import { ExplorerInspector } from "./ExplorerInspector";
import { ExplorerTree } from "./ExplorerTree";
import { ImageViewer } from "./ImageViewer";
import { MarkdownPreview } from "./MarkdownPreview";
import { MountModal } from "./MountModal";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { UrlModal } from "./UrlModal";
import { error as logError } from "../../../lib/logger";

const DEFAULT_TREE_WIDTH = 240;
const MIN_TREE_WIDTH = 208;
const MAX_TREE_WIDTH = 520;

export function ExplorerLayout({
  active,
  client
}: {
  active: boolean;
  client: ExplorerClient;
}) {
  const store = useExplorerStore(client);
  const [openModal, setOpenModal] = useState<CreateAction | null>(null);
  // parentId snapshot at modal-open time so the user can change selection
  // mid-modal without shifting the new node's parent.
  const [modalParentId, setModalParentId] = useState<string | null>(null);
  const [noteFlushError, setNoteFlushError] = useState<string | null>(null);
  const [mountSetupContext, setMountSetupContext] = useState<MountSetupContext | null>(null);
  const [mountSetupError, setMountSetupError] = useState<string | null>(null);
  const [mountSubmitting, setMountSubmitting] = useState(false);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const noteEditorRef = useRef<NoteEditorHandle>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Anchor for shift-click range selection. Tracks the most recent
  // single-clicked node id; reset by plain or toggle clicks.
  const selectionAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await store.refresh();
      } catch (cause) {
        store.setError(cause instanceof Error ? cause.message : "Unexpected backend error");
      } finally {
        store.setIsLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (openModal !== "mount") return;
    let cancelled = false;
    setMountSetupError(null);
    setMountSetupContext(null);

    void client
      .getMountSetupContext()
      .then((context) => {
        if (!cancelled) setMountSetupContext(context);
      })
      .catch((cause) => {
        if (!cancelled) {
          setMountSetupError(
            cause instanceof Error ? cause.message : "Failed to load suggested folders."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, openModal]);

  useExplorerEvents(store.refresh);

  // Window close: only the note editor has pending writes to flush. Previews
  // are read-only and cannot block close.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let unmounted = false;

    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const editor = noteEditorRef.current;
        if (editor) {
          event.preventDefault();
          try {
            await editor.flush();
            getCurrentWindow().close();
          } catch (cause) {
            setNoteFlushError(
              cause instanceof Error ? cause.message : "Failed to save note"
            );
          }
        }
      })
      .then((fn) => {
        if (unmounted) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch(() => {
        // onCloseRequested registration failed; nothing we can do client-side.
      });

    return () => {
      unmounted = true;
      unlistenFn?.();
    };
  }, []);

  // Selected single container, used as parentId for create operations.
  const selectedContainer = useMemo(() => {
    if (store.selectedArtifacts.length !== 1) return null;
    const node = store.selectedArtifacts[0];
    return isDisplayFolder(node) ? node : null;
  }, [store.selectedArtifacts]);
  const selectedContainerId = selectedContainer?.id;

  // The "active file" surface — the most-recent file activation drives the
  // center pane and breadcrumbs. Mutual-exclusion enforcement: note editor
  // takes render priority if multiple fields are inadvertently set.
  const activeFileNode: ExplorerNode | null =
    store.activeNote ?? store.activePreview ?? store.activeImagePreview ?? null;

  // Compute breadcrumb path for the active file node from the snapshot.
  const breadcrumbNodes = useMemo(() => {
    if (!activeFileNode) return [];
    const path: ExplorerNode[] = [];
    const index = new Map<string, ExplorerNode>();
    const visit = (node: ExplorerNode) => {
      index.set(node.id, node);
      node.children.forEach(visit);
    };
    store.snapshot.roots.forEach(visit);
    let cursor: ExplorerNode | null = activeFileNode;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentId ? index.get(cursor.parentId) ?? null : null;
    }
    return path;
  }, [activeFileNode, store.snapshot]);

  // Visible flat tree order (respects expansion). Used for shift-click range.
  const visibleOrder = useMemo(() => {
    const ordered: string[] = [];
    const expandedSet = new Set(store.expandedIds);
    function visit(node: ExplorerNode) {
      ordered.push(node.id);
      if (expandedSet.has(node.id)) {
        for (const child of node.children) visit(child);
      }
    }
    store.snapshot.roots.forEach(visit);
    return ordered;
  }, [store.snapshot, store.expandedIds]);

  // Layout-level wrapper that flushes any open note before delegating to the
  // store. Required because store.activateArtifact is synchronous and has no
  // ref to call flush().
  async function handleActivate(nodeId: string, modifiers: SelectModifiers) {
    setNoteFlushError(null);

    // Update selection based on modifier first (so the inspector reflects
    // the click target even if flush fails).
    if (modifiers.shift) {
      const anchor = selectionAnchorRef.current;
      const anchorIdx = anchor ? visibleOrder.indexOf(anchor) : -1;
      const targetIdx = visibleOrder.indexOf(nodeId);
      if (anchorIdx === -1 || targetIdx === -1) {
        // Anchor invisible (collapsed) or missing — fall back to plain click.
        selectionAnchorRef.current = nodeId;
        store.selectArtifact(nodeId, false);
      } else {
        const [start, end] =
          anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
        const range = visibleOrder.slice(start, end + 1);
        store.replaceSelection(range);
      }
    } else if (modifiers.toggle) {
      selectionAnchorRef.current = nodeId;
      store.selectArtifact(nodeId, true);
    } else {
      selectionAnchorRef.current = nodeId;
      store.selectArtifact(nodeId, false);
    }

    // Then the activation side effect (note flush, surface change, URL open).
    if (store.activeNoteId && noteEditorRef.current) {
      try {
        await noteEditorRef.current.flush();
        store.setActiveNoteId(null);
      } catch (cause) {
        setNoteFlushError(
          cause instanceof Error ? cause.message : "Failed to save note"
        );
        return;
      }
    }

    // Look up the activated node to handle URL-open externally.
    const indexed = (function findInTree(roots: ExplorerNode[]): ExplorerNode | null {
      for (const root of roots) {
        if (root.id === nodeId) return root;
        const found = findInTree(root.children);
        if (found) return found;
      }
      return null;
    })(store.snapshot.roots);

    if (indexed?.kind === "url") {
      // Open the URL in the system default browser. Treat failures as
      // selection-only fallback.
      try {
        await openExternal(indexed.name);
      } catch (cause) {
        void logError(
          `[ExplorerLayout] failed to open URL: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
      return;
    }

    store.activateArtifact(nodeId);
  }

  function handleCreateSelect(action: CreateAction) {
    const parentId = selectedContainerId ?? null;
    if (action === "folder") {
      void handleFolderCreate(parentId);
    } else if (action === "note") {
      void handleNoteCreate(parentId);
    } else {
      // Modal-based create: snapshot parentId at open time so changing the
      // tree selection mid-modal doesn't shift the new node's parent.
      setModalParentId(parentId);
      setOpenModal(action);
    }
  }

  async function handleFolderCreate(parentId: string | null) {
    const snapshot = await store.runAction("folder", () =>
      client.createFolder({ name: "Untitled", parentId: parentId ?? undefined })
    );
    if (snapshot) {
      const prevIds = collectIds(store.snapshot.roots);
      store.applySnapshot(snapshot);
      for (const root of snapshot.roots) {
        const newId = findNewId(root, prevIds);
        if (newId) {
          store.setPendingInlineRenameId(newId);
          break;
        }
      }
    }
  }

  async function handleNoteCreate(parentId: string | null) {
    const snapshot = await store.runAction("note", () =>
      client.createNote({ parentId: parentId ?? undefined })
    );
    if (snapshot) {
      const prevIds = collectIds(store.snapshot.roots);
      store.applySnapshot(snapshot);
      for (const root of snapshot.roots) {
        const newId = findNewId(root, prevIds);
        if (newId) {
          store.setPendingInlineRenameId(newId);
          break;
        }
      }
    }
  }

  async function handleDeleteById(nodeId: string, cascade: boolean) {
    if (store.activeNoteId === nodeId) {
      store.setActiveNoteId(null);
      setNoteFlushError(null);
    }
    if (store.activePreviewId === nodeId) {
      store.setActivePreviewId(null);
    }
    if (store.activeImagePreviewId === nodeId) {
      store.setActiveImagePreviewId(null);
    }
    const snapshot = await store.runAction("delete", () =>
      client.deleteNode({ nodeId, cascade })
    );
    if (snapshot) store.applySnapshot(snapshot);
  }

  async function handleInlineRename(nodeId: string, newName: string) {
    store.setPendingInlineRenameId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const snapshot = await store.runAction("rename", () =>
      client.renameNode({ nodeId, newName: trimmed })
    );
    if (snapshot) store.applySnapshot(snapshot);
  }

  async function handleRetry(nodeId: string) {
    await store.runAction("retry", async () => {
      await client.retryUrl({ nodeId });
      await store.refresh();
    });
  }

  async function handleRevealInFileManager(nodeId: string) {
    try {
      await client.showNodeInFileManager(nodeId);
      store.setError(null);
    } catch (cause) {
      store.setError(cause instanceof Error ? cause.message : "Failed to open file manager");
    }
  }

  async function handleMountSubmit(args: { path: string; name: string; ignoreConfig: string }) {
    setMountSubmitting(true);
    store.setError(null);
    try {
      const snapshot = await client.createMount({
        path: args.path,
        parentId: modalParentId ?? undefined,
        ignoreConfig: args.ignoreConfig || undefined
      });
      store.applySnapshot(snapshot);
      setOpenModal(null);
      setModalParentId(null);
      setMountSetupContext(null);
      return;
    } catch (cause) {
      throw cause;
    } finally {
      setMountSubmitting(false);
    }
  }

  async function handleUrlSubmit(url: string) {
    const snapshot = await store.runAction("url", () =>
      client.createUrl({ url, parentId: modalParentId ?? undefined })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setOpenModal(null);
      setModalParentId(null);
    }
  }

  function handleModalClose() {
    setOpenModal(null);
    setModalParentId(null);
    setMountSetupContext(null);
    setMountSetupError(null);
  }

  async function handleRevealExistingMount(nodeId: string) {
    setNoteFlushError(null);
    if (store.activeNoteId && noteEditorRef.current) {
      try {
        await noteEditorRef.current.flush();
        store.setActiveNoteId(null);
      } catch (cause) {
        setNoteFlushError(cause instanceof Error ? cause.message : "Failed to save note");
        return;
      }
    }

    selectionAnchorRef.current = nodeId;
    store.selectArtifact(nodeId, false);
    if (!store.expandedIds.includes(nodeId)) {
      store.toggleNode(nodeId);
    }
    handleModalClose();
  }

  // Center surface decision. Note takes render priority if both fields are set.
  const showNote = !!store.activeNoteId && !!store.activeNote;
  const showMarkdown = !showNote && !!store.activePreviewId && !!store.activePreview;
  const showImage =
    !showNote &&
    !showMarkdown &&
    !!store.activeImagePreviewId &&
    !!store.activeImagePreview;
  // Cannot-preview placeholder: a single non-previewable file node is selected.
  const showCannotPreview =
    !showNote &&
    !showMarkdown &&
    !showImage &&
    store.selectionCount === 1 &&
    store.selectedArtifacts[0].kind === "file";
  const showWelcome = !showNote && !showMarkdown && !showImage && !showCannotPreview;
  const clampedTreeWidth = clampTreeWidth(treeWidth, workspaceRef.current);

  function handleResizeStart(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = clampedTreeWidth;

    function handleMouseMove(moveEvent: MouseEvent) {
      const delta = moveEvent.clientX - startX;
      setTreeWidth(clampTreeWidth(startWidth + delta, workspaceRef.current));
    }

    function handleMouseUp() {
      cleanupResizeListeners();
    }

    function cleanupResizeListeners() {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("is-resizing-pane");
      resizeCleanupRef.current = null;
    }

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanupResizeListeners;
    document.body.classList.add("is-resizing-pane");
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp, { once: true });
  }

  return (
    <section
      aria-hidden={!active}
      className={`explorer-layout${active ? " is-active" : " is-hidden"}`}
    >
      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div
        className="explorer-workspace"
        data-testid="explorer-workspace"
        ref={workspaceRef}
        style={{
          gridTemplateColumns: `${clampedTreeWidth}px 10px minmax(0, 1fr) 280px`,
        }}
      >
        <aside className="tree-sidebar">
          <ExplorerTree
            expandedIds={store.expandedIds}
            nodes={store.snapshot.roots}
            onDelete={handleDeleteById}
            onInlineRename={handleInlineRename}
            onRevealInFileManager={(nodeId) => {
              void handleRevealInFileManager(nodeId);
            }}
            onRetry={handleRetry}
            onSelect={(id, modifiers) => void handleActivate(id, modifiers)}
            onStartRename={store.setPendingInlineRenameId}
            onToggle={store.toggleNode}
            pendingInlineRenameId={store.pendingInlineRenameId}
            selectedIds={store.selectedArtifactIds}
            toolbar={<CreateMenu onSelect={handleCreateSelect} />}
          />
        </aside>

        <div
          aria-label="Resize file tree"
          aria-orientation="vertical"
          aria-valuemax={MAX_TREE_WIDTH}
          aria-valuemin={MIN_TREE_WIDTH}
          aria-valuenow={Math.round(clampedTreeWidth)}
          className="tree-resize-handle"
          onMouseDown={handleResizeStart}
          role="separator"
        />

        <main className="detail-surface">
          <div className="detail-surface-scroll">
            {store.isLoading ? (
              <p className="empty-state">Loading explorer...</p>
            ) : (
              <>
                {activeFileNode ? <Breadcrumbs nodes={breadcrumbNodes} /> : null}
                {showNote ? (
                  <NoteEditor
                    ref={noteEditorRef}
                    client={client}
                    flushError={noteFlushError}
                    initialTitle={store.activeNote!.name}
                    nodeId={store.activeNoteId!}
                    onTitleChange={() => {
                      void store.refresh().catch(() => {});
                    }}
                  />
                ) : null}
                {showMarkdown ? (
                  <MarkdownPreview
                    client={client}
                    name={store.activePreview!.name}
                    nodeId={store.activePreviewId!}
                  />
                ) : null}
                {showImage ? (
                  <ImageViewer
                    client={client}
                    name={store.activeImagePreview!.name}
                    nodeId={store.activeImagePreviewId!}
                  />
                ) : null}
                {showCannotPreview ? (
                  <div className="detail-placeholder">
                    <p>This file type cannot be previewed</p>
                  </div>
                ) : null}
                {showWelcome ? (
                  <div className="detail-placeholder">
                    <p>Select an item to preview</p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </main>

        <aside className="inspector-panel">
          <div className="inspector-panel-scroll">
            <ExplorerInspector
              node={store.inspectorNode}
              selectedArtifacts={store.selectedArtifacts}
              selectionCount={store.selectionCount}
            />
          </div>
        </aside>
      </div>

      {openModal === "mount" ? (
        <MountModal
          isSubmitting={mountSubmitting}
          onClose={handleModalClose}
          onRevealMount={(nodeId) => {
            void handleRevealExistingMount(nodeId);
          }}
          onSubmit={handleMountSubmit}
          setupContext={mountSetupContext}
          setupError={mountSetupError}
        />
      ) : null}

      {openModal === "url" ? (
        <UrlModal
          activeAction={store.activeAction}
          onClose={handleModalClose}
          onSubmit={handleUrlSubmit}
        />
      ) : null}
    </section>
  );
}

function collectIds(nodes: ExplorerNode[]): Set<string> {
  const ids = new Set<string>();
  function visit(node: ExplorerNode) {
    ids.add(node.id);
    node.children.forEach(visit);
  }
  nodes.forEach(visit);
  return ids;
}

function findNewId(node: ExplorerNode, prevIds: Set<string>): string | null {
  if (!prevIds.has(node.id)) return node.id;
  for (const child of node.children) {
    const found = findNewId(child, prevIds);
    if (found) return found;
  }
  return null;
}

function clampTreeWidth(nextWidth: number, workspace: HTMLDivElement | null) {
  const workspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
  const maxWidthFromViewport =
    workspaceWidth > 0 ? Math.max(MIN_TREE_WIDTH, workspaceWidth - 280 - 320 - 10) : MAX_TREE_WIDTH;
  const maxWidth = Math.min(MAX_TREE_WIDTH, maxWidthFromViewport);

  return Math.max(MIN_TREE_WIDTH, Math.min(nextWidth, maxWidth));
}
