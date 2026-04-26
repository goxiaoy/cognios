import { AlertTriangle, ChevronRight, File, Folder, FolderOpen, Globe, HardDrive, Loader } from "lucide-react";
import { KeyboardEvent as KE, MouseEvent, useEffect, useRef, useState } from "react";
import type { NodeKind, NodeState } from "../../../lib/contracts/vfs";
import type { ExplorerNode } from "../types/explorer";
import {
  formatCompactNodeMeta,
  formatTreeDisclosurePath,
} from "../utils/presentation";

export interface SelectModifiers {
  shift: boolean;
  toggle: boolean;
}

function NodeStateBadge({ state }: { state: NodeState }) {
  if (state === "ready") return null;
  if (state === "error" || state === "unavailable") {
    return <AlertTriangle className="node-state-icon state-error" size={12} aria-label="error" />;
  }
  return <Loader className="node-state-icon state-pending" size={12} aria-label="loading" />;
}

function KindIcon({ kind }: { kind: NodeKind }) {
  const props = { size: 13, "aria-hidden": true as const, className: "node-icon" };
  switch (kind) {
    case "folder":    return <Folder {...props} />;
    case "mount":     return <HardDrive {...props} />;
    case "directory": return <FolderOpen {...props} />;
    case "url":       return <Globe {...props} />;
    default:          return <File {...props} />;
  }
}

export function ExplorerRow({
  node,
  depth,
  isExpanded,
  isSelected,
  isInlineRenaming = false,
  onDelete,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename,
  onStartRename,
  pathNodes
}: {
  node: ExplorerNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isInlineRenaming?: boolean;
  onDelete(nodeId: string, cascade: boolean): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string, modifiers: SelectModifiers): void;
  onToggle(nodeId: string): void;
  onInlineRename?(nodeId: string, newName: string): void;
  onStartRename(nodeId: string): void;
  pathNodes: ExplorerNode[];
}) {
  const hasChildren = node.children.length > 0;
  const [editValue, setEditValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const disclosureTitle = formatTreeDisclosurePath(pathNodes) || node.name;
  const compactMeta = formatCompactNodeMeta(node);

  useEffect(() => {
    if (isInlineRenaming) {
      setEditValue(node.name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isInlineRenaming, node.name]);

  // Close context menu on outside mousedown or Escape
  useEffect(() => {
    if (!menuPos) return;
    function close() { setMenuPos(null); }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuPos]);

  useEffect(() => {
    if (!menuPos) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuPos(null);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [menuPos]);

  function commit() {
    const trimmed = editValue.trim();
    onInlineRename?.(node.id, trimmed || node.name);
  }

  function handleKeyDown(e: KE<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { setEditValue(node.name); onInlineRename?.(node.id, node.name); }
  }

  function handleContextMenu(e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }

  return (
    <div
      className={`tree-row${isSelected ? " is-selected" : ""}`}
      style={{ paddingLeft: `${0.5 + depth * 0.7}rem` }}
      onContextMenu={handleContextMenu}
    >
      <button
        aria-label={hasChildren ? (isExpanded ? "Collapse node" : "Expand node") : "Leaf node"}
        className="tree-expander"
        disabled={!hasChildren}
        onClick={() => hasChildren && onToggle(node.id)}
        type="button"
      >
        {hasChildren ? (
          <ChevronRight
            aria-hidden="true"
            className={`tree-expander-icon${isExpanded ? " is-expanded" : ""}`}
            size={11}
            strokeWidth={2.2}
          />
        ) : (
          <span aria-hidden="true" className="tree-expander-placeholder">
            ·
          </span>
        )}
      </button>

      {isInlineRenaming ? (
        <div className="tree-row-main tree-row-main--editing">
          <KindIcon kind={node.kind} />
          <input
            ref={inputRef}
            className="tree-inline-input"
            title={disclosureTitle}
            onBlur={commit}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            value={editValue}
          />
        </div>
      ) : (
        <button
          className="tree-row-main"
          onClick={(e) =>
            onSelect(node.id, {
              shift: e.shiftKey,
              toggle: e.metaKey || e.ctrlKey,
            })
          }
          title={disclosureTitle}
          type="button"
        >
          <span className="tree-row-primary">
            <KindIcon kind={node.kind} />
            <span className="node-name">{node.name}</span>
          </span>
          <span className="tree-row-secondary">
            {compactMeta ? <span className="tree-row-meta">{compactMeta}</span> : null}
            <NodeStateBadge state={node.state} />
          </span>
        </button>
      )}

      {menuPos ? (
        <div
          className="tree-context-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="tree-context-item"
            onClick={() => { onStartRename(node.id); setMenuPos(null); }}
            type="button"
          >
            Rename
          </button>
          {node.kind === "url" && node.state === "error" ? (
            <button
              className="tree-context-item"
              onClick={() => { onRetry(node.id); setMenuPos(null); }}
              type="button"
            >
              Retry fetch
            </button>
          ) : null}
          <div className="tree-context-separator" />
          <button
            className="tree-context-item tree-context-item--danger"
            onClick={() => { setMenuPos(null); setConfirmDelete(true); }}
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}

      {confirmDelete ? (
        <div
          className="modal-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }}
        >
          <div className="modal">
            <header className="modal-header">
              <div>
                <p className="eyebrow">Confirm delete</p>
                <h2 className="modal-title">{node.name}</h2>
              </div>
              <button
                aria-label="Cancel"
                className="modal-close"
                onClick={() => setConfirmDelete(false)}
                type="button"
              >
                ✕
              </button>
            </header>
            <div className="modal-body">
              {node.kind === "mount" ? (
                <p className="delete-confirm-warning">
                  Deleting a mount will permanently remove the source files from disk. This cannot be undone.
                </p>
              ) : (
                <p className="muted-copy">
                  {hasChildren
                    ? `"${node.name}" and all its children will be permanently deleted.`
                    : `"${node.name}" will be permanently deleted.`}
                </p>
              )}
            </div>
            <footer className="modal-footer">
              <button
                className="ghost-button"
                onClick={() => setConfirmDelete(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => { setConfirmDelete(false); onDelete(node.id, hasChildren); }}
                type="button"
              >
                Delete
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
