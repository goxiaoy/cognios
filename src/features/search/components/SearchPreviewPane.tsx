import { useEffect, useState } from "react";
import type { ExplorerClient, ExplorerNode } from "../../explorer/types/explorer";
import { ImageViewer } from "../../explorer/components/ImageViewer";
import { MarkdownPreview } from "../../explorer/components/MarkdownPreview";
import { isImageNode, isMarkdownFile } from "../../explorer/utils/presentation";

/**
 * Read-only preview surface inside :class:`SearchView`.
 *
 * Mirrors the ``ExplorerLayout`` center-pane decision tree but always
 * renders read-only (no NoteEditor — the user is browsing search
 * results, not editing). Notes are rendered as markdown via
 * ``getNoteContent``. Files reuse the existing MarkdownPreview /
 * ImageViewer components so behaviour stays consistent across surfaces.
 */
export function SearchPreviewPane({
  node,
  client,
}: {
  node: ExplorerNode | null;
  client: ExplorerClient;
}) {
  if (!node) {
    return (
      <div className="search-preview search-preview-empty">
        <p className="muted-copy">Select a result to preview.</p>
      </div>
    );
  }

  if (node.kind === "note") {
    return <NotePreview client={client} node={node} />;
  }

  if (node.kind === "file") {
    if (isMarkdownFile(node)) {
      return (
        <div className="search-preview">
          <MarkdownPreview client={client} name={node.name} nodeId={node.id} />
        </div>
      );
    }
    if (isImageNode(node)) {
      return (
        <div className="search-preview">
          <ImageViewer client={client} name={node.name} nodeId={node.id} />
        </div>
      );
    }
  }

  return (
    <div className="search-preview search-preview-empty">
      <p className="muted-copy">This {node.kind} cannot be previewed inline.</p>
    </div>
  );
}

function NotePreview({
  client,
  node,
}: {
  client: ExplorerClient;
  node: ExplorerNode;
}) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setContent("");
    void (async () => {
      try {
        const body = await client.getNoteContent(node.id);
        if (!cancelled) setContent(body);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load note");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, node.id]);

  if (isLoading) {
    return (
      <div className="search-preview search-preview-empty">
        <p className="muted-copy">Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="search-preview search-preview-empty">
        <p className="error-banner">{error}</p>
      </div>
    );
  }
  return (
    <div className="search-preview">
      <header className="search-preview-header">
        <h2 className="search-preview-title">{node.name}</h2>
      </header>
      {/* Plain-text rendering — snippets and note content are
          untrusted text. SEC-FINDING-002: never use
          dangerouslySetInnerHTML on indexed content. */}
      <pre className="search-preview-note-body">{content}</pre>
    </div>
  );
}
