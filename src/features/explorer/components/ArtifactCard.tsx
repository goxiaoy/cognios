import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ExplorerNode, ExplorerViewMode } from "../types/explorer";
import { isDisplayFolder } from "../store/useExplorerStore";
import {
  formatNodeDate,
  formatNodeKindLabel,
  isImageNode,
  nodeGlyph
} from "../utils/presentation";

const thumbnailCache = new Map<string, string>();
const inflightThumbnails = new Map<string, Promise<string | null>>();

export function ArtifactCard({
  loadThumbnail,
  node,
  mode,
  selected,
  isRenaming = false,
  onActivate,
  onDelete,
  onInlineRename,
  onRetry,
  onSelect,
  onStartRename
}: {
  loadThumbnail(nodeId: string): Promise<string>;
  node: ExplorerNode;
  mode: ExplorerViewMode;
  selected: boolean;
  isRenaming?: boolean;
  onActivate(nodeId: string): void;
  onDelete(nodeId: string, cascade: boolean): void;
  onInlineRename?(nodeId: string, newName: string): void;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string, additive: boolean): void;
  onStartRename(nodeId: string): void;
}) {
  const thumbnailKey = useMemo(() => `${node.id}:${node.modifiedAt}`, [node.id, node.modifiedAt]);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(
    thumbnailCache.get(thumbnailKey) ?? null
  );
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasChildren = node.children.length > 0;

  useEffect(() => {
    if (isRenaming) {
      setEditValue(node.name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isRenaming, node.name]);

  function commitRename() {
    const trimmed = editValue.trim();
    onInlineRename?.(node.id, trimmed || node.name);
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { setEditValue(node.name); onInlineRename?.(node.id, node.name); }
  }

  useEffect(() => {
    if (!isImageNode(node)) {
      setThumbnailSrc(null);
      return;
    }

    const cached = thumbnailCache.get(thumbnailKey);
    if (cached) {
      setThumbnailSrc(cached);
      return;
    }

    let cancelled = false;
    const currentRequest =
      inflightThumbnails.get(thumbnailKey) ??
      Promise.resolve()
        .then(() => loadThumbnail(node.id))
        .catch(() => null)
        .finally(() => {
          inflightThumbnails.delete(thumbnailKey);
        });
    inflightThumbnails.set(thumbnailKey, currentRequest);

    currentRequest.then((value) => {
      if (value) thumbnailCache.set(thumbnailKey, value);
      if (!cancelled) setThumbnailSrc(thumbnailCache.get(thumbnailKey) ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [loadThumbnail, node, thumbnailKey]);

  useEffect(() => {
    if (!menuPos) return;
    function close() { setMenuPos(null); }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuPos]);

  useEffect(() => {
    if (!menuPos) return;
    function handleKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setMenuPos(null);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [menuPos]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onSelect(node.id, event.metaKey || event.ctrlKey);
  }

  function handleContextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setMenuPos({ x: event.clientX, y: event.clientY });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" && isDisplayFolder(node)) {
      event.preventDefault();
      onActivate(node.id);
    }
  }

  return (
    <>
      <button
        className={`artifact-card artifact-card-${mode}${selected ? " is-selected" : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={() => onActivate(node.id)}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <span className="artifact-visual" aria-hidden="true">
          {thumbnailSrc ? (
            <img alt="" className="artifact-thumbnail" src={thumbnailSrc} />
          ) : (
            nodeGlyph(node)
          )}
        </span>
        <span className="artifact-copy">
          {isRenaming ? (
            <input
              ref={inputRef}
              className="artifact-inline-input"
              onBlur={commitRename}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              value={editValue}
            />
          ) : (
            <span className="artifact-name">{node.name}</span>
          )}
          <span className="artifact-meta">
            <span className="artifact-badge">{formatNodeKindLabel(node)}</span>
            <span className="artifact-date">{formatNodeDate(node.modifiedAt)}</span>
          </span>
        </span>
      </button>

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
    </>
  );
}
