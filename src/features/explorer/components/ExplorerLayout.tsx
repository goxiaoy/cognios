import { useEffect, useState } from "react";
import type { ExplorerClient, ExplorerNode } from "../types/explorer";
import type { CreateAction } from "./CreateMenu";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStore } from "../store/useExplorerStore";
import { ExplorerContentGrid } from "./ExplorerContentGrid";
import { ExplorerInspector } from "./ExplorerInspector";
import { MountModal } from "./MountModal";
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

  function handleCreateSelect(action: CreateAction) {
    if (action === "folder") {
      void handleFolderCreate();
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

  async function handleDeleteById(nodeId: string, cascade: boolean) {
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

  return (
    <section
      aria-hidden={!active}
      className={`explorer-layout${active ? " is-active" : " is-hidden"}`}
    >
      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div className={`explorer-workspace${store.inspectorNode || store.selectionCount > 1 ? " has-inspector" : ""}`}>
        {store.isLoading ? (
          <p className="empty-state">Loading explorer...</p>
        ) : null}

        {!store.isLoading ? (
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

        <aside className="inspector-panel">
          <ExplorerInspector
            node={store.inspectorNode}
            selectedArtifacts={store.selectedArtifacts}
            selectionCount={store.selectionCount}
          />
        </aside>
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
