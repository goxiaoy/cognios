import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { NodeContentChunk } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";

/**
 * Center-pane preview for image nodes — renders the **indexed** text
 * (OCR + caption) as markdown, while the inspector on the right
 * shows the actual image thumbnail. The split keeps the workspace
 * readable: searchable text content takes the wide pane, the raster
 * stays in a sidebar where its size is bounded.
 *
 * Content shape:
 *
 * - The sidecar returns ``chunks: [{id, role, text}]`` for every
 *   indexed node. Image nodes have ``role="body"`` rows for OCR text
 *   and ``role="summary"`` rows for caption text. Both categories
 *   may contain multiple chunks (long captions split through the
 *   chunker the same way body text does); this component joins each
 *   category in chunk-index order before rendering it as one section.
 * - When neither extractor has produced text yet (the OCR /
 *   captioner extras aren't installed, or the runner hasn't drained
 *   the queue), we render an explanatory empty state so the user
 *   isn't staring at a blank pane.
 */
export function ImagePreview({
  searchClient,
  nodeId,
  name,
}: {
  searchClient: SearchClient;
  nodeId: string;
  name: string;
}) {
  const [chunks, setChunks] = useState<NodeContentChunk[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setChunks(null);
    void (async () => {
      try {
        const env = await searchClient.nodeContent(nodeId);
        if (cancelled) return;
        if (env.state === "ready" && env.data) {
          setChunks(env.data.chunks);
        } else if (env.state === "initialising") {
          setError("Search subsystem is still starting…");
        } else {
          setError(env.error ?? "Could not load indexed content.");
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Failed to load content."
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchClient, nodeId]);

  const sections = buildSections(chunks ?? []);

  return (
    <div className="image-preview">
      <header className="image-preview-header">
        <h2 className="image-preview-title">{name}</h2>
      </header>

      {isLoading ? (
        <p className="image-preview-empty muted-copy" role="status">
          Loading indexed content…
        </p>
      ) : error ? (
        <p className="image-preview-empty image-preview-error" role="status">
          {error}
        </p>
      ) : sections.length === 0 ? (
        <ImagePreviewEmptyState />
      ) : (
        <div className="image-preview-body">
          {sections.map((section) => (
            <ImagePreviewSection key={section.label} section={section} />
          ))}
        </div>
      )}
    </div>
  );
}

interface PreviewSection {
  label: string;
  body: string;
}

function buildSections(chunks: NodeContentChunk[]): PreviewSection[] {
  // Chunks arrive pre-sorted by the sidecar: body first (numeric idx
  // ascending), summary after (also numeric idx ascending). We split
  // by role and stitch each side back into one rendered section.
  const body = chunks
    .filter((c) => c.role === "body")
    .map((c) => c.text)
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  const summary = chunks
    .filter((c) => c.role === "summary")
    .map((c) => c.text)
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  const sections: PreviewSection[] = [];
  if (body) sections.push({ label: "OCR", body });
  if (summary) sections.push({ label: "Caption", body: summary });
  return sections;
}

function ImagePreviewSection({ section }: { section: PreviewSection }) {
  return (
    <section className="image-preview-section">
      <h3 className="image-preview-section-label">{section.label}</h3>
      <div className="image-preview-section-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
      </div>
    </section>
  );
}

function ImagePreviewEmptyState() {
  return (
    <div className="image-preview-empty muted-copy">
      <p>
        No OCR or caption text indexed yet for this image. Once the
        OCR extractor and image captioner are wired (Settings →
        Models), text content will appear here.
      </p>
    </div>
  );
}
