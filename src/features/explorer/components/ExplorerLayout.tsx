import { FormEvent, useEffect, useState } from "react";
import { DEFAULT_MOUNT_IGNORE_CONFIG } from "../../../lib/contracts/vfs";
import type { ExplorerClient } from "../types/explorer";
import { useExplorerEvents } from "../hooks/useExplorerEvents";
import { useExplorerStore } from "../store/useExplorerStore";
import { Breadcrumbs } from "./Breadcrumbs";
import { CreateNodeDialog } from "./CreateNodeDialog";
import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog";
import { ExplorerTree } from "./ExplorerTree";

export function ExplorerLayout({ client }: { client: ExplorerClient }) {
  const store = useExplorerStore(client);
  const [folderName, setFolderName] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [mountIgnoreConfig, setMountIgnoreConfig] = useState(DEFAULT_MOUNT_IGNORE_CONFIG);
  const [urlValue, setUrlValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [cascadeDelete, setCascadeDelete] = useState(false);

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

  useEffect(() => {
    setRenameValue(store.selectedNode?.name ?? "");
    setCascadeDelete(false);
  }, [store.selectedNode]);

  async function handleFolderSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = folderName.trim();
    if (!trimmedName) return;

    const snapshot = await store.runAction("folder", () =>
      client.createFolder({ name: trimmedName, parentId: store.selectedNode?.kind === "folder" ? store.selectedNode.id : undefined })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setFolderName("");
    }
  }

  async function handleMountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedPath = mountPath.trim();
    if (!trimmedPath) return;

    const snapshot = await store.runAction("mount", () =>
      client.createMount({
        path: trimmedPath,
        parentId: store.selectedNode?.kind === "folder" ? store.selectedNode.id : undefined,
        ignoreConfig: mountIgnoreConfig
      })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setMountPath("");
    }
  }

  async function handleUrlSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = urlValue.trim();
    if (!trimmedUrl) return;

    const snapshot = await store.runAction("url", () =>
      client.createUrl({
        url: trimmedUrl,
        parentId: store.selectedNode?.kind === "folder" ? store.selectedNode.id : undefined
      })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
      setUrlValue("");
    }
  }

  async function handleRename() {
    if (!store.selectedNode) return;
    const trimmedName = renameValue.trim();
    if (!trimmedName) return;

    const snapshot = await store.runAction("rename", () =>
      client.renameNode({ nodeId: store.selectedNode!.id, newName: trimmedName })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
    }
  }

  async function handleDelete() {
    if (!store.selectedNode) return;
    const snapshot = await store.runAction("delete", () =>
      client.deleteNode({ nodeId: store.selectedNode!.id, cascade: cascadeDelete })
    );
    if (snapshot) {
      store.applySnapshot(snapshot);
    }
  }

  async function handleRetry(nodeId: string) {
    await store.runAction("retry", async () => {
      await client.retryUrl({ nodeId });
      await store.refresh();
    });
  }

  return (
    <section className="workspace-panel explorer-layout">
      <header className="panel-header explorer-header">
        <div>
          <p className="eyebrow">Explorer</p>
          <h2>VFS Graph</h2>
        </div>
        <Breadcrumbs nodes={store.breadcrumbs} onSelect={store.selectNode} />
      </header>

      {store.error ? <p className="error-banner">{store.error}</p> : null}

      <div className="explorer-grid">
        <section className="tree-panel">
          {store.isLoading ? <p className="empty-state">Loading explorer...</p> : null}
          {!store.isLoading && store.snapshot.roots.length === 0 ? (
            <p className="empty-state">
              No nodes yet. Create a folder, mount a directory, or add a URL to
              verify the persistence pipeline.
            </p>
          ) : null}
          {!store.isLoading && store.snapshot.roots.length > 0 ? (
            <ExplorerTree
              expandedIds={store.expandedIds}
              nodes={store.snapshot.roots}
              onRetry={handleRetry}
              onSelect={store.selectNode}
              onToggle={store.toggleNode}
              selectedId={store.selectedId}
            />
          ) : null}
        </section>

        <aside className="inspector-panel">
          <CreateNodeDialog
            activeAction={store.activeAction}
            folderName={folderName}
            mountIgnoreConfig={mountIgnoreConfig}
            mountPath={mountPath}
            onFolderChange={setFolderName}
            onFolderSubmit={handleFolderSubmit}
            onMountChange={setMountPath}
            onMountIgnoreChange={setMountIgnoreConfig}
            onMountSubmit={handleMountSubmit}
            onUrlChange={setUrlValue}
            onUrlSubmit={handleUrlSubmit}
            urlValue={urlValue}
          />

          <section className="inspector-block">
            <header className="inspector-block-header">
              <p className="eyebrow">Inspect</p>
              <h3>{store.selectedNode?.name ?? "No node selected"}</h3>
            </header>
            {store.selectedNode ? (
              <>
                <dl className="detail-grid">
                  <div>
                    <dt>Kind</dt>
                    <dd>{store.selectedNode.kind}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{store.selectedNode.state}</dd>
                  </div>
                  <div>
                    <dt>Children</dt>
                    <dd>{store.selectedNode.children.length}</dd>
                  </div>
                </dl>
                <div className="field-stack">
                  <label className="field-label" htmlFor="rename-value">
                    Rename
                  </label>
                  <div className="inline-form">
                    <input
                      id="rename-value"
                      onChange={(event) => setRenameValue(event.target.value)}
                      value={renameValue}
                    />
                    <button
                      disabled={store.activeAction !== null || !renameValue.trim()}
                      onClick={handleRename}
                      type="button"
                    >
                      {store.activeAction === "rename" ? "Renaming..." : "Rename"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p className="muted-copy">
                Select a node to inspect its metadata and mutation actions.
              </p>
            )}
          </section>

          <DeleteConfirmationDialog
            activeAction={store.activeAction}
            cascade={cascadeDelete}
            onCascadeChange={setCascadeDelete}
            onDelete={handleDelete}
            selectedNode={store.selectedNode}
          />
        </aside>
      </div>
    </section>
  );
}
