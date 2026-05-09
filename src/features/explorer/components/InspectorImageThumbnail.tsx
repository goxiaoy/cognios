import { useEffect, useState } from "react";
import { X } from "lucide-react";

import type { ExplorerClient } from "../types/explorer";

/**
 * Inspector-side image thumbnail. Reuses the same
 * ``client.getNodeThumbnail`` IPC the old center-pane viewer used,
 * but renders sized to fit the inspector column. The thumbnail
 * backend collapses every failure into one opaque error string;
 * the UI maps that to a single muted "preview unavailable" message
 * to avoid pretending we know which underlying cause fired.
 */
export function InspectorImageThumbnail({
  client,
  nodeId,
  name,
}: {
  client: ExplorerClient;
  nodeId: string;
  name: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setHasError(false);
    setDataUrl(null);
    void (async () => {
      try {
        const result = await client.getNodeThumbnail(nodeId);
        if (!cancelled) setDataUrl(result);
      } catch {
        if (!cancelled) setHasError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, nodeId]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (isLoading) {
    return (
      <div className="inspector-image inspector-image--placeholder muted-copy">
        Loading…
      </div>
    );
  }

  if (hasError || !dataUrl) {
    return (
      <div className="inspector-image inspector-image--placeholder muted-copy">
        Preview unavailable.
      </div>
    );
  }

  return (
    <>
      <div
        aria-label={`Open image preview for ${name}`}
        className="inspector-image inspector-image--interactive"
        onDoubleClick={() => setIsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setIsOpen(true);
        }}
        role="button"
        tabIndex={0}
      >
        <img alt={name} className="inspector-image-img" src={dataUrl} />
      </div>
      {isOpen ? (
        <div
          aria-label={`Image preview: ${name}`}
          aria-modal="true"
          className="inspector-image-lightbox-backdrop"
          onClick={() => setIsOpen(false)}
          role="dialog"
        >
          <div
            className="inspector-image-lightbox"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              aria-label="Close image preview"
              className="inspector-image-lightbox-close"
              onClick={() => setIsOpen(false)}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
            <img
              alt={name}
              className="inspector-image-lightbox-img"
              src={dataUrl}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
