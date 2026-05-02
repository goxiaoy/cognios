import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
 * - The ImageProcessor stores ``"OCR: <text>\\n\\nCaption: <text>"``
 *   under each image node's chunks. We split the joined string on
 *   those prefixes so the UI can render each as its own section
 *   header. Either side missing is fine — the section is omitted.
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
  const [joined, setJoined] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setJoined(null);
    void (async () => {
      try {
        const env = await searchClient.nodeContent(nodeId);
        if (cancelled) return;
        if (env.state === "ready" && env.data) {
          setJoined(env.data.joined);
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

  const sections = useMemo(() => parseSections(joined ?? ""), [joined]);

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
          {sections.map((section, idx) => (
            <ImagePreviewSection key={idx} section={section} />
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

/**
 * Split the joined chunks string back into ``{ OCR, Caption }``
 * sections. The format is whatever ImageProcessor emits — currently
 * ``"OCR: <text>\\n\\nCaption: <text>"`` with either side optional.
 *
 * Any text outside the recognised prefixes (e.g. a non-image node
 * routed through this surface) becomes a single "Content" section
 * so we never silently drop bytes the indexer captured.
 */
export function parseSections(joined: string): PreviewSection[] {
  const trimmed = joined.trim();
  if (!trimmed) return [];

  const ocrMatch = trimmed.match(/OCR:\s*([\s\S]*?)(?=\n\nCaption:|$)/);
  const captionMatch = trimmed.match(/Caption:\s*([\s\S]*?)$/);

  const sections: PreviewSection[] = [];
  if (ocrMatch && ocrMatch[1].trim()) {
    sections.push({ label: "OCR", body: ocrMatch[1].trim() });
  }
  if (captionMatch && captionMatch[1].trim()) {
    sections.push({ label: "Caption", body: captionMatch[1].trim() });
  }

  if (sections.length === 0) {
    // No recognised prefix — treat the whole blob as one section so
    // we never drop indexed text (e.g. a non-image node that ended
    // up here, or a future format change).
    sections.push({ label: "Content", body: trimmed });
  }
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
