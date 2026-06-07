import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type {
  NodeStageStatus,
  NodeStatusView,
} from "../../../lib/contracts/nodeStatus";
import type { NodeContentChunk } from "../../../lib/contracts/search";
import { VFS_EVENT_NAME, type VfsChangeEvent } from "../../../lib/tauri/events";
import type { SearchClient } from "../../search/types/search";
import { rewriteAssetReferences } from "../utils/assetReferences";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MarkdownView } from "./MarkdownView";

type ViewMode = "preview" | "source";
type PreviewContentKind = "image" | "pdf" | "url";

/**
 * Center-pane preview for extracted document content — renders the
 * **indexed** OCR / text-layer / URL article output as markdown.
 * Images may also include a caption summary; PDFs use the same body
 * chunks for text-layer and advanced-OCR markdown.
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
  contentKind = "image",
  searchClient,
  nodeId,
  nodeStatus,
  name,
}: {
  contentKind?: PreviewContentKind;
  searchClient: SearchClient;
  nodeId: string;
  nodeStatus?: NodeStatusView | null;
  name: string;
}) {
  const [chunks, setChunks] = useState<NodeContentChunk[] | null>(null);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("preview");

  const fetchChunks = useCallback(
    async (signal: { cancelled: boolean }, withSpinner: boolean) => {
      if (withSpinner) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const env = await searchClient.nodeContent(nodeId);
        if (signal.cancelled) return;
        if (env.state === "ready" && env.data) {
          setChunks(env.data.chunks);
          setAssets(env.data.assets ?? {});
          setError(null);
        } else if (env.state === "initialising") {
          if (withSpinner) setError("Search subsystem is still starting…");
        } else {
          if (withSpinner) {
            setError(env.error ?? "Could not load indexed content.");
          }
        }
      } catch (cause) {
        if (!signal.cancelled && withSpinner) {
          setError(
            cause instanceof Error ? cause.message : "Failed to load content."
          );
        }
      } finally {
        if (!signal.cancelled && withSpinner) setIsLoading(false);
      }
    },
    [searchClient, nodeId]
  );

  // Initial fetch + a quiet re-fetch on every vfs change event. The
  // sidecar's index-state-sync emits ``vfs://changed`` after a batch
  // of state transitions; without re-fetching here, the preview stays
  // at the pre-indexing empty state even after the runner finishes
  // OCR-ing the image. Quiet re-fetches don't toggle the spinner so
  // the live update is invisible until new chunks actually arrive.
  useEffect(() => {
    const signal = { cancelled: false };
    void fetchChunks(signal, true);
    let unlisten: (() => void) | undefined;
    void listen<VfsChangeEvent>(VFS_EVENT_NAME, () => {
      void fetchChunks(signal, false);
    }).then((fn) => {
      if (signal.cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      signal.cancelled = true;
      unlisten?.();
    };
  }, [fetchChunks]);

  const sections = buildSections(chunks ?? [], contentKind);
  const renderedSections = sections.map((section) => ({
    ...section,
    previewBody: rewriteAssetReferences(section.body, assets),
  }));
  const enhancementStatus =
    contentKind === "url"
      ? null
      : enhancementStatusFor(
          nodeStatus?.stages.find((stage) => stage.id === "image.enhance")
        );

  return (
    <div className="image-preview">
      <header className="image-preview-header">
        <div className="image-preview-heading">
          <h2 className="image-preview-title">{name}</h2>
          {enhancementStatus ? (
            <p
              className={`image-preview-enhancement-status is-${enhancementStatus.tone}`}
              role="status"
              title={enhancementStatus.title}
            >
              {enhancementStatus.label}
            </p>
          ) : null}
        </div>
        {renderedSections.length > 0 ? (
          <div
            className="markdown-preview-mode-toggle"
            role="tablist"
            aria-label="View mode"
          >
            <button
              aria-pressed={mode === "preview"}
              className={`markdown-preview-mode-button${mode === "preview" ? " is-active" : ""}`}
              onClick={() => setMode("preview")}
              role="tab"
              type="button"
            >
              Preview
            </button>
            <button
              aria-pressed={mode === "source"}
              className={`markdown-preview-mode-button${mode === "source" ? " is-active" : ""}`}
              onClick={() => setMode("source")}
              role="tab"
              type="button"
            >
              Source
            </button>
          </div>
        ) : null}
      </header>

      {isLoading ? (
        <p className="image-preview-empty muted-copy" role="status">
          Loading indexed content…
        </p>
      ) : error ? (
        <p className="image-preview-empty image-preview-error" role="status">
          {error}
        </p>
      ) : renderedSections.length === 0 ? (
        <ImagePreviewEmptyState contentKind={contentKind} />
      ) : (
        <div className="image-preview-body">
          {renderedSections.map((section) => (
            <ImagePreviewSection
              key={section.label}
              mode={mode}
              section={section}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function enhancementStatusFor(stage?: NodeStageStatus | null):
  | {
      label: string;
      title: string;
      tone: "pending" | "ok" | "error" | "neutral";
    }
  | null {
  if (!stage || stage.state === "skipped") return null;
  const detail = stage.error?.message ?? stage.message ?? "";
  const suffix = detail ? `: ${detail}` : "";
  if (stage.state === "pending") {
    return {
      label: `OCR enhancement queued${suffix}`,
      title: detail || "OCR enhancement queued",
      tone: "pending",
    };
  }
  if (stage.state === "running") {
    return {
      label: `OCR enhancement running${suffix}`,
      title: detail || "OCR enhancement running",
      tone: "pending",
    };
  }
  if (stage.state === "succeeded") {
    return {
      label: "OCR enhancement ready",
      title: detail || "OCR enhancement ready",
      tone: "ok",
    };
  }
  if (stage.state === "failed" || stage.state === "blocked") {
    return {
      label: `OCR enhancement failed${suffix}`,
      title: detail || "OCR enhancement failed",
      tone: "error",
    };
  }
  return {
    label: `OCR enhancement ${stage.state}${suffix}`,
    title: detail || `OCR enhancement ${stage.state}`,
    tone: "neutral",
  };
}

interface PreviewSection {
  label: string;
  body: string;
  previewBody?: string;
}

function buildSections(
  chunks: NodeContentChunk[],
  contentKind: PreviewContentKind
): PreviewSection[] {
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
  if (body) {
    sections.push({
      label:
        contentKind === "url"
          ? "Page"
          : contentKind === "pdf"
            ? "Extracted Text"
            : "OCR",
      body,
    });
  }
  if (summary) sections.push({ label: "Caption", body: summary });
  return sections;
}

function ImagePreviewSection({
  mode,
  section,
}: {
  mode: ViewMode;
  section: PreviewSection;
}) {
  return (
    <section className="image-preview-section">
      <h3 className="image-preview-section-label">{section.label}</h3>
      {mode === "preview" ? (
        <div className="image-preview-section-body markdown-body">
          <MarkdownRenderer>
            {section.previewBody ?? section.body}
          </MarkdownRenderer>
        </div>
      ) : (
        <MarkdownView
          className="image-preview-section-source"
          readOnly={true}
          value={section.body}
        />
      )}
    </section>
  );
}

function ImagePreviewEmptyState({
  contentKind,
}: {
  contentKind: PreviewContentKind;
}) {
  if (contentKind === "pdf") {
    return (
      <div className="image-preview-empty muted-copy">
        <p>
          This PDF hasn't produced extracted text yet. Text-layer
          indexing runs first, then PaddleOCR enhancement can render
          structured markdown here once it finishes.
        </p>
      </div>
    );
  }
  if (contentKind === "url") {
    return (
      <div className="image-preview-empty muted-copy">
        <p>
          This URL hasn't produced a readable page preview yet. The cached HTML
          is parsed into Markdown during indexing; results appear here once
          indexing finishes.
        </p>
      </div>
    );
  }
  return (
    <div className="image-preview-empty muted-copy">
      <p>
        This image hasn't been indexed yet. Local PaddleOCR will
        extract its text in the background — results appear here
        once indexing finishes. To also generate searchable
        descriptions, enable Image captioning in Settings.
      </p>
    </div>
  );
}
