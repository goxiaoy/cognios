import { KeyboardEvent as KE, useEffect, useRef, useState } from "react";
import type { ExplorerNode } from "../types/explorer";

export function ExplorerRow({
  node,
  depth,
  isExpanded,
  isSelected,
  isInlineRenaming = false,
  onRetry,
  onSelect,
  onToggle,
  onInlineRename
}: {
  node: ExplorerNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isInlineRenaming?: boolean;
  onRetry(nodeId: string): void;
  onSelect(nodeId: string): void;
  onToggle(nodeId: string): void;
  onInlineRename?(nodeId: string, newName: string): void;
}) {
  const hasChildren = node.children.length > 0;
  const [editValue, setEditValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isInlineRenaming) {
      setEditValue(node.name);
      // defer so the input is in the DOM
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [isInlineRenaming, node.name]);

  function commit() {
    const trimmed = editValue.trim();
    onInlineRename?.(node.id, trimmed || node.name);
  }

  function handleKeyDown(e: KE<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { setEditValue(node.name); onInlineRename?.(node.id, node.name); }
  }

  return (
    <div
      className={`tree-row${isSelected ? " is-selected" : ""}`}
      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
    >
      <button
        aria-label={hasChildren ? (isExpanded ? "Collapse node" : "Expand node") : "Leaf node"}
        className="tree-expander"
        disabled={!hasChildren}
        onClick={() => hasChildren && onToggle(node.id)}
        type="button"
      >
        <span className={`tree-expander-icon${isExpanded ? " is-expanded" : ""}`}>
          {hasChildren ? "›" : "·"}
        </span>
      </button>

      {isInlineRenaming ? (
        <div className="tree-row-main">
          <span className="node-kind">{node.kind}</span>
          <input
            ref={inputRef}
            className="tree-inline-input"
            onBlur={commit}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            value={editValue}
          />
        </div>
      ) : (
        <button
          className="tree-row-main"
          onClick={() => onSelect(node.id)}
          type="button"
        >
          <span className="node-kind">{node.kind}</span>
          <span className="node-name">{node.name}</span>
          <span className={`node-state state-${node.state}`}>{node.state}</span>
        </button>
      )}

      {node.kind === "url" && node.state === "error" ? (
        <button className="tree-inline-action" onClick={() => onRetry(node.id)} type="button">
          Retry
        </button>
      ) : null}
    </div>
  );
}
