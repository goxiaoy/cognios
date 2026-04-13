import { KeyboardEvent, MouseEvent, useEffect, useMemo, useState } from "react";
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
  onActivate,
  onSelect
}: {
  loadThumbnail(nodeId: string): Promise<string>;
  node: ExplorerNode;
  mode: ExplorerViewMode;
  selected: boolean;
  onActivate(nodeId: string): void;
  onSelect(nodeId: string, additive: boolean): void;
}) {
  const thumbnailKey = useMemo(() => `${node.id}:${node.modifiedAt}`, [node.id, node.modifiedAt]);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(
    thumbnailCache.get(thumbnailKey) ?? null
  );

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

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onSelect(node.id, event.metaKey || event.ctrlKey);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" && isDisplayFolder(node)) {
      event.preventDefault();
      onActivate(node.id);
    }
  }

  return (
    <button
      className={`artifact-card artifact-card-${mode}${selected ? " is-selected" : ""}`}
      onClick={handleClick}
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
        <span className="artifact-name">{node.name}</span>
        <span className="artifact-meta">
          <span className="artifact-badge">{formatNodeKindLabel(node)}</span>
          <span className="artifact-date">{formatNodeDate(node.modifiedAt)}</span>
        </span>
      </span>
    </button>
  );
}
