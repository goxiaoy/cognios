import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ExplorerClient } from "../types/explorer";
import { MarkdownView } from "./MarkdownView";
import { VisualMarkdownEditor } from "./VisualMarkdownEditor";

export interface NoteEditorHandle {
  flush(): Promise<void>;
}

interface NoteEditorProps {
  client: ExplorerClient;
  nodeId: string;
  initialTitle: string;
  onTitleChange(newTitle: string): void;
  flushError: string | null;
  afterHeader?: ReactNode;
}

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function NoteEditor(
    { client, nodeId, initialTitle, onTitleChange, flushError, afterHeader },
    ref
  ) {
    const [title, setTitle] = useState(initialTitle);
    const [body, setBody] = useState("");
    const [mode, setMode] = useState<"visual" | "raw">("visual");
    const [isLoadingBody, setIsLoadingBody] = useState(true);

    // Pending body that hasn't been saved yet.
    const pendingBodyRef = useRef<string | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      let cancelled = false;
      setIsLoadingBody(true);
      void (async () => {
        try {
          const content = await client.getNoteContent(nodeId);
          if (!cancelled) setBody(content);
        } finally {
          if (!cancelled) setIsLoadingBody(false);
        }
      })();
      return () => { cancelled = true; };
    }, [client, nodeId]);

    useEffect(() => {
      setTitle(initialTitle);
    }, [initialTitle, nodeId]);

    useEffect(() => {
      return () => {
        if (debounceTimerRef.current !== null) {
          clearTimeout(debounceTimerRef.current);
        }
      };
    }, []);

    useImperativeHandle(ref, () => ({
      async flush() {
        if (pendingBodyRef.current === null) return;
        if (debounceTimerRef.current !== null) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        const toSave = pendingBodyRef.current;
        pendingBodyRef.current = null;
        await client.saveNoteContent(nodeId, toSave);
      },
    }), [client, nodeId]);

    function handleBodyChange(value: string) {
      setBody(value);
      pendingBodyRef.current = value;

      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const toSave = pendingBodyRef.current;
        if (toSave === null) return;
        pendingBodyRef.current = null;
        void client.saveNoteContent(nodeId, toSave);
      }, 500);
    }

    async function handleTitleBlur() {
      const trimmed = title.trim() || "Untitled";
      if (trimmed !== title) setTitle(trimmed);
      if (trimmed !== initialTitle) {
        try {
          await client.renameNode({ nodeId, newName: trimmed });
          onTitleChange(trimmed);
        } catch {
          // Non-fatal — the next save or navigation will retry if needed.
        }
      }
    }

    return (
      <div className="note-editor">
        {flushError ? (
          <p className="note-editor-flush-error">{flushError}</p>
        ) : null}

        <div className="note-editor-body">
          <input
            aria-label="Note title"
            className="note-editor-title"
            onBlur={() => void handleTitleBlur()}
            onChange={(e) => setTitle(e.target.value)}
            type="text"
            value={title}
          />
          <div className="note-editor-meta-row">
            <p className="note-editor-storage-hint">Stored locally on your device</p>
            <div
              className="markdown-preview-mode-toggle note-editor-mode-toggle"
              role="tablist"
              aria-label="Editor mode"
            >
              <button
                aria-pressed={mode === "visual"}
                className={`markdown-preview-mode-button${mode === "visual" ? " is-active" : ""}`}
                onClick={() => setMode("visual")}
                role="tab"
                type="button"
              >
                Visual
              </button>
              <button
                aria-pressed={mode === "raw"}
                className={`markdown-preview-mode-button${mode === "raw" ? " is-active" : ""}`}
                onClick={() => setMode("raw")}
                role="tab"
                type="button"
              >
                Raw
              </button>
            </div>
          </div>

          {afterHeader ? <div className="note-editor-after-header">{afterHeader}</div> : null}

          {!isLoadingBody ? (
            mode === "visual" ? (
              <VisualMarkdownEditor
                onChange={handleBodyChange}
                placeholder="Start writing..."
                value={body}
              />
            ) : (
              <MarkdownView
                className="note-editor-codemirror"
                onChange={handleBodyChange}
                placeholder="Start writing..."
                readOnly={false}
                value={body}
              />
            )
          ) : null}
        </div>
      </div>
    );
  }
);
