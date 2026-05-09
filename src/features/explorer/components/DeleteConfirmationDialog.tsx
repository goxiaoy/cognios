import type { ExplorerNode } from "../types/explorer";

export function DeleteConfirmationDialog({
  activeAction,
  cascade,
  onCascadeChange,
  onDelete,
  selectedNode
}: {
  activeAction: "folder" | "mount" | "url" | "rename" | "delete" | "retry" | null;
  cascade: boolean;
  onCascadeChange(value: boolean): void;
  onDelete(): void;
  selectedNode: ExplorerNode | null;
}) {
  if (!selectedNode) {
    return (
      <section className="inspector-block">
        <header className="inspector-block-header">
          <p className="eyebrow">Delete</p>
          <h3>Destructive actions</h3>
        </header>
        <p className="muted-copy">Select a node to rename or delete it.</p>
      </section>
    );
  }

  const requiresCascade = selectedNode.kind === "folder" && selectedNode.children.length > 0;

  return (
    <section className="inspector-block">
      <header className="inspector-block-header">
        <p className="eyebrow">Delete</p>
        <h3>{selectedNode.name}</h3>
      </header>
      <p className="muted-copy">
        This removes the selected {selectedNode.kind}
        {selectedNode.kind === "mount" ? " without touching the source folder." : "."}
      </p>
      {requiresCascade ? (
        <label className="checkbox-row">
          <input
            checked={cascade}
            onChange={(event) => onCascadeChange(event.target.checked)}
            type="checkbox"
          />
          <span>Also delete all child nodes.</span>
        </label>
      ) : null}
      <button
        className="danger-button"
        disabled={activeAction !== null || (requiresCascade && !cascade)}
        onClick={onDelete}
        type="button"
      >
        {activeAction === "delete" ? "Deleting..." : "Delete Node"}
      </button>
    </section>
  );
}
