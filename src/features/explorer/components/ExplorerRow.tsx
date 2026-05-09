import { ChevronRight } from "lucide-react";
import { KeyboardEvent as KE, MouseEvent, useEffect, useRef, useState } from "react";
import type { ExplorerNode } from "../types/explorer";
import {
  formatCompactNodeMeta,
  formatTreeDisclosurePath,
  nodeIconComponent,
} from "../utils/presentation";
import { NodeStateDot } from "./NodeStateDot";

export interface SelectModifiers {
  shift: boolean;
  toggle: boolean;
}

function NodeIcon({ node }: { node: ExplorerNode }) {
  const Icon = nodeIconComponent(node);
  return <Icon size={13} aria-hidden className="node-icon" />;
}

export function ExplorerRow({
  node,
  depth,
  isExpanded,
  isSelected,
  isInlineRenaming = false,
  onDelete,
  onOpenUrl,
  onRevealInFileManager,
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
  onOpenUrl(nodeId: string): void;
  onRevealInFileManager(nodeId: string): void;
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
  const canRevealInFileManager = node.kind === "mount" || node.kind === "file" || node.kind === "note";
  const revealLabel = fileManagerRevealLabel();

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
      style={{ paddingLeft: `${0.4 + depth * 0.45}rem` }}
      onContextMenu={handleContextMenu}
    >
      {hasChildren ? (
        <button
          aria-label={isExpanded ? "Collapse node" : "Expand node"}
          className="tree-expander"
          onClick={() => onToggle(node.id)}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className={`tree-expander-icon${isExpanded ? " is-expanded" : ""}`}
            size={11}
            strokeWidth={2.2}
          />
        </button>
      ) : (
        <span aria-hidden="true" className="tree-expander-spacer" />
      )}

      {isInlineRenaming ? (
        <div className="tree-row-main tree-row-main--editing">
          <NodeIcon node={node} />
          <input
            ref={inputRef}
            className="tree-inline-input"
            title={menuPos ? undefined : disclosureTitle}
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
          // Suppress the native ``title`` tooltip while the context
          // menu is open — macOS renders OS-level tooltips above all
          // web content, blocking clicks on menu items underneath.
          title={menuPos ? undefined : disclosureTitle}
          type="button"
        >
          <span className="tree-row-primary">
            <NodeIcon node={node} />
            <span className="node-name">{node.name}</span>
          </span>
          <span className="tree-row-secondary">
            {compactMeta ? <span className="tree-row-meta">{compactMeta}</span> : null}
            <NodeStateDot kind={node.kind} state={node.state} />
          </span>
        </button>
      )}

      {menuPos ? (
        <div
          className="tree-context-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {node.kind === "url" ? (
            <button
              className="tree-context-item"
              onClick={() => { onOpenUrl(node.id); setMenuPos(null); }}
              type="button"
            >
              Open link
            </button>
          ) : null}
          {canRevealInFileManager ? (
            <button
              className="tree-context-item"
              onClick={() => { onRevealInFileManager(node.id); setMenuPos(null); }}
              type="button"
            >
              {revealLabel}
            </button>
          ) : null}
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
                  Removing a mount only unlinks it from CogniOS. The source folder and its files stay on disk.
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

function fileManagerRevealLabel() {
  if (typeof navigator !== "undefined") {
    const platform = navigator.userAgent.toLowerCase();
    if (platform.includes("mac")) return "Show in Finder";
    if (platform.includes("win")) return "Show in Explorer";
  }

  return "Show in Folder";
}
