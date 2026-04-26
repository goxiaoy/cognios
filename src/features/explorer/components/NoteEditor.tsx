import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ArrowLeft } from "lucide-react";
import type { ExplorerClient } from "../types/explorer";
import { MarkdownView } from "./MarkdownView";

export interface NoteEditorHandle {
  flush(): Promise<void>;
}

interface NoteEditorProps {
  client: ExplorerClient;
  nodeId: string;
  initialTitle: string;
  onTitleChange(newTitle: string): void;
  onBack(): void;
  flushError: string | null;
}

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(
  function NoteEditor(
    { client, nodeId, initialTitle, onTitleChange, onBack, flushError },
    ref
  ) {
    const [title, setTitle] = useState(initialTitle);
    const [body, setBody] = useState("");
    const [isLoadingBody, setIsLoadingBody] = useState(true);

    // Pending body that hasn't been saved yet.
    const pendingBodyRef = useRef<string | null>(null);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      let cancelled = false;
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
        <header className="note-editor-header">
          <button
            aria-label="Back to explorer"
            className="note-editor-back"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back
          </button>
        </header>

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
          <p className="note-editor-storage-hint">Stored locally on your device</p>

          {!isLoadingBody ? (
            <MarkdownView
              className="note-editor-codemirror"
              onChange={handleBodyChange}
              placeholder="Start writing…"
              readOnly={false}
              value={body}
            />
          ) : null}
        </div>
      </div>
    );
  }
);
