import { useEffect, useState } from "react";
import type { ExplorerNode } from "../types/explorer";
import type { ExplorerClient } from "../types/explorer";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStore } from "../store/useExplorerStore";
import { Breadcrumbs } from "./Breadcrumbs";
import { CreateMenu, type CreateAction } from "./CreateMenu";
import { ExplorerContentGrid } from "./ExplorerContentGrid";
import { ExplorerInspector } from "./ExplorerInspector";
import { ExplorerTree } from "./ExplorerTree";
import { MountModal } from "./MountModal";
import { UrlModal } from "./UrlModal";

function collectIds(nodes: ExplorerNode[]): Set<string> {
  const ids = new Set<string>();
  function visit(node: ExplorerNode) {
    ids.add(node.id);
    node.children.forEach(visit);
  }
  nodes.forEach(visit);
  return ids;
}

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
    const prevIds = collectIds(store.snapshot.roots);
    const snapshot = await store.runAction("folder", () =>
      client.createFolder({
        name: "Untitled",
        parentId: store.displayedFolder ? store.displayedFolder.id : undefined
      })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      // find the new node and start inline rename
      for (const root of snapshot.roots) {
        const newId = findNewId(root, prevIds);
        if (newId) {
          store.selectTreeNode(newId);
          store.setPendingInlineRenameId(newId);
          break;
        }
      }
    }
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

  return (
    <section
      aria-hidden={!active}
      className={`explorer-layout${active ? " is-active" : " is-hidden"}`}
    >
      <div className="explorer-breadcrumb-bar">
        <Breadcrumbs
          nodes={store.breadcrumbs}
          onSelect={(id) => store.selectDisplayedFolder(id)}
        />
      </div>

      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div className="explorer-workspace">
        <section
          className={`hierarchy-panel${store.isHierarchyCollapsed ? " is-collapsed" : ""}`}
        >
          <div className="hierarchy-header">
            <div>
              <p className="eyebrow">Hierarchy</p>
            </div>
            <div className="hierarchy-header-actions">
              {!store.isHierarchyCollapsed ? (
                <CreateMenu onSelect={handleCreateSelect} />
              ) : null}
              <button
                className="hierarchy-toggle"
                onClick={store.toggleHierarchyCollapsed}
                type="button"
              >
                {store.isHierarchyCollapsed ? "»" : "«"}
              </button>
            </div>
          </div>

          {!store.isHierarchyCollapsed ? (
            <>
              {store.isLoading ? <p className="empty-state">Loading explorer...</p> : null}
              {!store.isLoading && store.snapshot.roots.length === 0 ? (
                <p className="empty-state">
                  No nodes yet. Use + New to create a folder, mount a directory, or add a URL.
                </p>
              ) : null}
              {!store.isLoading && store.snapshot.roots.length > 0 ? (
                <ExplorerTree
                  expandedIds={store.expandedIds}
                  nodes={store.snapshot.roots}
                  pendingInlineRenameId={store.pendingInlineRenameId}
                  onDelete={handleDeleteById}
                  onInlineRename={handleInlineRename}
                  onRetry={handleRetry}
                  onSelect={store.selectTreeNode}
                  onStartRename={store.setPendingInlineRenameId}
                  onToggle={store.toggleNode}
                  selectedId={store.displayedFolderId}
                />
              ) : null}
            </>
          ) : null}
        </section>

        <ExplorerContentGrid
          displayedFolderName={store.displayedFolder?.name ?? "Workspace Roots"}
          loadThumbnail={client.getNodeThumbnail}
          nodes={store.visibleArtifacts}
          onActivate={store.activateArtifact}
          onSelect={store.selectArtifact}
          onViewModeChange={store.setViewMode}
          selectedIds={store.selectedArtifactIds}
          selectionCount={store.selectionCount}
          viewMode={store.viewMode}
        />

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

function findNewId(node: ExplorerNode, prevIds: Set<string>): string | null {
  if (!prevIds.has(node.id)) return node.id;
  for (const child of node.children) {
    const found = findNewId(child, prevIds);
    if (found) return found;
  }
  return null;
}
