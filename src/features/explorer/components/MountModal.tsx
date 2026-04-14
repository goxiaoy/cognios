import { DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen } from "lucide-react";
import { DEFAULT_MOUNT_IGNORE_CONFIG } from "../../../lib/contracts/vfs";

function basenameOf(path: string) {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() ?? "";
}

export function MountModal({
  activeAction,
  onClose,
  onSubmit
}: {
  activeAction: string | null;
  onClose(): void;
  onSubmit(args: { path: string; name: string; ignoreConfig: string }): void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useIgnore, setUseIgnore] = useState(true);
  const [ignoreConfig, setIgnoreConfig] = useState(DEFAULT_MOUNT_IGNORE_CONFIG);
  const [dragging, setDragging] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Dismiss on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Tauri v2 drag-drop: listen to window-level event to get real file paths
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // Guard: getCurrentWindow() throws outside Tauri context (tests, browser)
    try {
      getCurrentWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            const paths: string[] = (event.payload as { paths?: string[] }).paths ?? [];
            if (paths[0]) applyPath(paths[0]);
          } else {
            setDragging(false);
          }
        })
        .then((fn) => { if (!cancelled) unlisten = fn; });
    } catch {
      // Not running inside Tauri — ignore
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyPath(newPath: string) {
    setPath(newPath);
    setName((prev) => (prev === basenameOf(path) || prev === "") ? basenameOf(newPath) : prev);
  }

  async function handlePickFolder() {
    const selected = await openFilePicker({ directory: true, multiple: false });
    if (typeof selected === "string") applyPath(selected);
  }

  // Fallback web drag-drop (works in browser/dev mode; Tauri event takes priority in prod)
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0] as File & { path?: string };
    if (file?.path) applyPath(file.path);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedPath = path.trim();
    if (!trimmedPath) return;
    const trimmedName = name.trim() || basenameOf(trimmedPath) || trimmedPath;
    onSubmit({
      path: trimmedPath,
      name: trimmedName,
      ignoreConfig: useIgnore ? ignoreConfig : ""
    });
  }

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Mount directory"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Mount</p>
            <h2 className="modal-title">Link a local directory</h2>
          </div>
          <button
            aria-label="Close"
            className="modal-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>

        <form className="modal-body" onSubmit={handleSubmit}>
          {/* Drop zone — also clickable to open native folder picker */}
          <button
            className={`drop-zone${dragging ? " is-dragging" : ""}${path ? " has-value" : ""}`}
            onClick={handlePickFolder}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            type="button"
          >
            {path ? (
              <>
                <FolderOpen size={22} className="drop-zone-icon" aria-hidden="true" />
                <span className="drop-zone-path">{path}</span>
                <span
                  className="drop-zone-clear"
                  role="button"
                  aria-label="Clear path"
                  onClick={(e) => { e.stopPropagation(); setPath(""); setName(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setPath(""); setName(""); } }}
                  tabIndex={0}
                >
                  ✕
                </span>
              </>
            ) : (
              <>
                <FolderOpen size={28} className="drop-zone-icon" aria-hidden="true" />
                <span className="drop-zone-label">Click to choose a folder</span>
                <span className="drop-zone-hint">or drag and drop here</span>
              </>
            )}
          </button>

          {/* Path input */}
          <div className="field-stack">
            <label className="field-label" htmlFor="mount-path-input">Path</label>
            <input
              id="mount-path-input"
              onChange={(e) => applyPath(e.target.value)}
              placeholder="~/projects/example"
              value={path}
            />
          </div>

          {/* Name input */}
          <div className="field-stack">
            <label className="field-label" htmlFor="mount-name-input">Name</label>
            <input
              ref={nameRef}
              id="mount-name-input"
              onChange={(e) => setName(e.target.value)}
              placeholder="Auto-filled from folder name"
              value={name}
            />
          </div>

          {/* Advanced section */}
          <div className="advanced-section">
            <button
              className="advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
              type="button"
              aria-expanded={advancedOpen}
            >
              <span className={`advanced-toggle-icon${advancedOpen ? " is-open" : ""}`}>›</span>
              Advanced
            </button>

            {advancedOpen ? (
              <div className="advanced-body">
                <label className="checkbox-row">
                  <input
                    checked={useIgnore}
                    onChange={(e) => setUseIgnore(e.target.checked)}
                    type="checkbox"
                  />
                  <span>Use ignore patterns</span>
                </label>
                {useIgnore ? (
                  <div className="field-stack">
                    <label className="field-label" htmlFor="mount-ignore-config">
                      Ignore config
                    </label>
                    <textarea
                      id="mount-ignore-config"
                      onChange={(e) => setIgnoreConfig(e.target.value)}
                      value={ignoreConfig}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <footer className="modal-footer">
            <button className="ghost-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button disabled={activeAction !== null || !path.trim()} type="submit">
              {activeAction === "mount" ? "Mounting…" : "Mount"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
