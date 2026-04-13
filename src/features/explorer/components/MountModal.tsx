import { DragEvent, FormEvent, useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function applyPath(newPath: string) {
    setPath(newPath);
    // auto-fill name only when user hasn't manually typed one
    setName((prev) => (prev === basenameOf(path) || prev === "") ? basenameOf(newPath) : prev);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    // only clear when leaving the drop zone itself, not a child
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    // Tauri desktop webview exposes a non-standard `.path` on File objects
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
          {/* Drop zone */}
          <div
            className={`drop-zone${dragging ? " is-dragging" : ""}${path ? " has-value" : ""}`}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {path ? (
              <>
                <span className="drop-zone-icon" aria-hidden="true">⧉</span>
                <span className="drop-zone-path">{path}</span>
                <button
                  className="drop-zone-clear"
                  onClick={() => { setPath(""); setName(""); }}
                  type="button"
                  aria-label="Clear path"
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                <span className="drop-zone-icon" aria-hidden="true">⧉</span>
                <span className="drop-zone-label">Drop a folder here</span>
                <span className="drop-zone-hint">or type the path below</span>
              </>
            )}
          </div>

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
