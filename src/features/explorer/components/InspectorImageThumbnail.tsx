import { useEffect, useState } from "react";

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
    <div className="inspector-image">
      <img alt={name} className="inspector-image-img" src={dataUrl} />
    </div>
  );
}
