import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen } from "lucide-react";
import type { DuplicateMountError, ExistingMount, MountSetupContext } from "../../../lib/contracts/vfs";
import { DEFAULT_MOUNT_IGNORE_CONFIG } from "../../../lib/contracts/vfs";

function basenameOf(path: string) {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() ?? "";
}

export function MountModal({
  isSubmitting,
  setupContext,
  setupError,
  onClose,
  onRevealMount,
  onSubmit,
}: {
  isSubmitting: boolean;
  setupContext: MountSetupContext | null;
  setupError: string | null;
  onClose(): void;
  onRevealMount(nodeId: string): void;
  onSubmit(args: { path: string; name: string; ignoreConfig: string }): Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useIgnore, setUseIgnore] = useState(true);
  const [ignoreConfig, setIgnoreConfig] = useState(DEFAULT_MOUNT_IGNORE_CONFIG);
  const [dragging, setDragging] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverDuplicateMount, setServerDuplicateMount] = useState<ExistingMount | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const existingMounts = setupContext?.existingMounts ?? [];
  const suggestedFolders = setupContext?.suggestedFolders ?? [];
  const duplicateMount = useMemo(
    () => findDuplicateMount(path, existingMounts) ?? serverDuplicateMount,
    [existingMounts, path, serverDuplicateMount]
  );

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
    setSubmitError(null);
    setServerDuplicateMount(null);
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedPath = path.trim();
    if (!trimmedPath) return;
    const trimmedName = name.trim() || basenameOf(trimmedPath) || trimmedPath;
    const localDuplicate = findDuplicateMount(trimmedPath, existingMounts);
    if (localDuplicate) {
      setServerDuplicateMount(localDuplicate);
      setSubmitError("This folder is already mounted.");
      return;
    }

    try {
      await onSubmit({
        path: trimmedPath,
        name: trimmedName,
        ignoreConfig: useIgnore ? ignoreConfig : ""
      });
    } catch (error) {
      if (isDuplicateMountError(error)) {
        setServerDuplicateMount({
          nodeId: error.mountId,
          name: error.mountName,
          absolutePath: error.absolutePath,
        });
        setSubmitError(error.message);
        return;
      }

      setSubmitError(error instanceof Error ? error.message : "Failed to mount folder.");
    }
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
          {suggestedFolders.length > 0 ? (
            <section className="mount-suggestions" aria-label="Suggested folders">
              <div className="mount-suggestions-header">
                <p className="field-label">Suggested folders</p>
                <p className="mount-suggestions-hint">Detected from Obsidian vaults on this computer</p>
              </div>
              <div className="mount-suggestion-list">
                {suggestedFolders.map((suggestion) => (
                  <button
                    className="mount-suggestion"
                    key={suggestion.path}
                    onClick={() => applyPath(suggestion.path)}
                    type="button"
                  >
                    <span className="mount-suggestion-name">{suggestion.name}</span>
                    <span className="mount-suggestion-path">{suggestion.path}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {setupError ? (
            <p className="mount-setup-error">{setupError}</p>
          ) : null}

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

          {duplicateMount ? (
            <div className="mount-duplicate-callout" role="status">
              <div>
                <p className="mount-duplicate-title">{submitError ?? "This folder is already mounted."}</p>
                <p className="mount-duplicate-path">{duplicateMount.absolutePath}</p>
              </div>
              <button
                className="ghost-button"
                onClick={() => onRevealMount(duplicateMount.nodeId)}
                type="button"
              >
                Reveal existing mount
              </button>
            </div>
          ) : submitError ? (
            <p className="mount-submit-error">{submitError}</p>
          ) : null}

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
            <button disabled={isSubmitting || !path.trim()} type="submit">
              {isSubmitting ? "Mounting…" : "Mount"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function findDuplicateMount(path: string, existingMounts: ExistingMount[]) {
  const normalizedCandidate = normalizePathForComparison(path);
  if (!normalizedCandidate) return null;

  return (
    existingMounts.find(
      (mount) => normalizePathForComparison(mount.absolutePath) === normalizedCandidate
    ) ?? null
  );
}

function normalizePathForComparison(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isDuplicateMountError(error: unknown): error is DuplicateMountError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<DuplicateMountError>;
  return (
    candidate.kind === "duplicateMount" &&
    typeof candidate.mountId === "string" &&
    typeof candidate.absolutePath === "string"
  );
}
