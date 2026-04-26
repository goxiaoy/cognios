import { useEffect, useState } from "react";
import type { ExplorerClient } from "../types/explorer";

interface ImageViewerProps {
  client: ExplorerClient;
  nodeId: string;
  name: string;
}

export function ImageViewer({ client, nodeId, name }: ImageViewerProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setDataUrl(null);
    void (async () => {
      try {
        const result = await client.getNodeThumbnail(nodeId);
        if (!cancelled) setDataUrl(result);
      } catch (cause) {
        if (!cancelled) {
          // The thumbnail backend collapses size-cap, missing-file, and
          // permission errors into one opaque "thumbnail unavailable"
          // string. We map that to a single user-facing message.
          const raw = cause instanceof Error ? cause.message : String(cause);
          setLoadError(messageForError(raw));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, nodeId]);

  return (
    <div className="image-viewer">
      <header className="image-viewer-header">
        <h2 className="image-viewer-title">{name}</h2>
      </header>

      <div className="image-viewer-body">
        {loadError ? (
          <p className="image-viewer-error">{loadError}</p>
        ) : !isLoading && dataUrl ? (
          <img alt={name} className="image-viewer-image" src={dataUrl} />
        ) : null}
      </div>
    </div>
  );
}

function messageForError(_raw: string): string {
  // Backend collapses to a single opaque error today; keep the user message
  // generic until/unless the backend differentiates "too large" vs other.
  return "This image is too large or unavailable to preview.";
}
