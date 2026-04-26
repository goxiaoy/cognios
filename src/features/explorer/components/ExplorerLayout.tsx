import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ExplorerClient, ExplorerNode } from "../types/explorer";
import type { CreateAction } from "./CreateMenu";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStore } from "../store/useExplorerStore";
import { ExplorerContentGrid } from "./ExplorerContentGrid";
import { ExplorerInspector } from "./ExplorerInspector";
import { MountModal } from "./MountModal";
import { NoteEditor, type NoteEditorHandle } from "./NoteEditor";
import { UrlModal } from "./UrlModal";

export function ExplorerLayout({
  active,
  client
}: {
  active: boolean;
  client: ExplorerClient;
}) {
  const store = useExplorerStore(client);
  const [openModal, setOpenModal] = useState<CreateAction | null>(null);
  const [noteFlushError, setNoteFlushError] = useState<string | null>(null);
  const noteEditorRef = useRef<NoteEditorHandle>(null);

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

  useExplorerEvents(store.refresh);

  // Flush any pending note save and close the editor. If flush fails, surface
  // the error and keep the editor open (blocks navigation per R12).
  async function flushAndCloseEditor() {
    if (!noteEditorRef.current) {
      store.setActiveNoteId(null);
      setNoteFlushError(null);
      return;
    }
    try {
      await noteEditorRef.current.flush();
      store.setActiveNoteId(null);
      setNoteFlushError(null);
    } catch (cause) {
      setNoteFlushError(
        cause instanceof Error ? cause.message : "Failed to save note"
      );
    }
  }

  // Register window close handler — flush before allowing the window to close.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

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
        unlistenFn = fn;
      });

    return () => {
      unlistenFn?.();
    };
  }, []);

  function handleCreateSelect(action: CreateAction) {
    if (action === "folder") {
      void handleFolderCreate();
    } else if (action === "note") {
      void handleNoteCreate();
    } else {
      setOpenModal(action);
    }
  }

  async function handleFolderCreate() {
    const snapshot = await store.runAction("folder", () =>
      client.createFolder({
        name: "Untitled",
        parentId: store.displayedFolder ? store.displayedFolder.id : undefined
      })
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

  async function handleNoteCreate() {
    const snapshot = await store.runAction("note", () =>
      client.createNote({
        parentId: store.displayedFolder ? store.displayedFolder.id : undefined
      })
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

  async function handleMountSubmit(args: { path: string; name: string; ignoreConfig: string }) {
    const snapshot = await store.runAction("mount", () =>
      client.createMount({
        path: args.path,
        parentId: store.displayedFolder ? store.displayedFolder.id : undefined,
        ignoreConfig: args.ignoreConfig || undefined
      })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setOpenModal(null);
    }
  }

  async function handleUrlSubmit(url: string) {
    const snapshot = await store.runAction("url", () =>
      client.createUrl({
        url,
        parentId: store.displayedFolder ? store.displayedFolder.id : undefined
      })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setOpenModal(null);
    }
  }

  const noteIsOpen = !!store.activeNoteId && !!store.activeNote;

  return (
    <section
      aria-hidden={!active}
      className={`explorer-layout${active ? " is-active" : " is-hidden"}`}
    >
      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div className={`explorer-workspace${!noteIsOpen && (store.inspectorNode || store.selectionCount > 1) ? " has-inspector" : ""}`}>
        {store.isLoading ? (
          <p className="empty-state">Loading explorer...</p>
        ) : null}

        {!store.isLoading && noteIsOpen ? (
          <NoteEditor
            ref={noteEditorRef}
            client={client}
            flushError={noteFlushError}
            initialTitle={store.activeNote!.name}
            nodeId={store.activeNoteId!}
            onBack={() => void flushAndCloseEditor()}
            onTitleChange={() => {
              // Refresh the tree so the new title appears in the node list.
              void store.refresh().catch(() => {});
            }}
          />
        ) : null}

        {!store.isLoading && !noteIsOpen ? (
          <ExplorerContentGrid
            breadcrumbs={store.breadcrumbs}
            loadThumbnail={client.getNodeThumbnail}
            nodes={store.visibleArtifacts}
            pendingInlineRenameId={store.pendingInlineRenameId}
            onActivate={store.activateArtifact}
            onBreadcrumbSelect={store.selectDisplayedFolder}
            onCreateSelect={handleCreateSelect}
            onDelete={handleDeleteById}
            onInlineRename={handleInlineRename}
            onRetry={handleRetry}
            onSelect={store.selectArtifact}
            onStartRename={store.setPendingInlineRenameId}
            onViewModeChange={store.setViewMode}
            selectedIds={store.selectedArtifactIds}
            selectionCount={store.selectionCount}
            viewMode={store.viewMode}
          />
        ) : null}

        {!noteIsOpen ? (
          <aside className="inspector-panel">
            <ExplorerInspector
              node={store.inspectorNode}
              selectedArtifacts={store.selectedArtifacts}
              selectionCount={store.selectionCount}
            />
          </aside>
        ) : null}
      </div>

      {openModal === "mount" ? (
        <MountModal
          activeAction={store.activeAction}
          onClose={() => setOpenModal(null)}
          onSubmit={handleMountSubmit}
        />
      ) : null}

      {openModal === "url" ? (
        <UrlModal
          activeAction={store.activeAction}
          onClose={() => setOpenModal(null)}
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
