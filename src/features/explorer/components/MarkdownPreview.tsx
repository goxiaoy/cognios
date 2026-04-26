import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { ExplorerClient } from "../types/explorer";
import { MarkdownView } from "./MarkdownView";

type ViewMode = "preview" | "source";

interface MarkdownPreviewProps {
  client: ExplorerClient;
  nodeId: string;
  name: string;
  onBack(): void;
}

export function MarkdownPreview({
  client,
  nodeId,
  name,
  onBack,
}: MarkdownPreviewProps) {
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("preview");
  const backButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const content = await client.readFileContent(nodeId);
        if (!cancelled) setBody(content);
      } catch (cause) {
        if (!cancelled) {
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

  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  return (
    <div className="markdown-preview">
      <header className="markdown-preview-header">
        <button
          aria-label="Back to explorer"
          className="markdown-preview-back"
          onClick={onBack}
          ref={backButtonRef}
          type="button"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </button>
        <h2 className="markdown-preview-title">{name}</h2>
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
      </header>

      <div className="markdown-preview-body">
        <p className="markdown-preview-hint">Read-only preview</p>

        {loadError ? (
          <p className="markdown-preview-error">{loadError}</p>
        ) : !isLoading ? (
          mode === "preview" ? (
            <div className="markdown-preview-rendered">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
              >
                {body}
              </ReactMarkdown>
            </div>
          ) : (
            <MarkdownView
              className="markdown-preview-codemirror"
              readOnly={true}
              value={body}
            />
          )
        ) : null}
      </div>
    </div>
  );
}

function messageForError(raw: string): string {
  switch (raw) {
    case "file too large":
      return "This file is too large to preview.";
    case "not previewable":
      return "This file type cannot be previewed.";
    default:
      return "This file is not available.";
  }
}
