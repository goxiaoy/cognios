import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import type { SearchClient } from "../../search/types/search";
import { SettingsLayout } from "./SettingsLayout";

/**
 * Modal wrapper around :class:`SettingsLayout`. The Settings entry
 * sits in the sidebar footer (separate from the primary nav) and
 * opens this overlay rather than navigating to a section. Closes
 * via the X button, the Escape key, or a click on the backdrop.
 */
export function SettingsModal({
  client,
  onClose,
}: {
  client: SearchClient;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Restore focus to whatever was focused before the modal opened.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <header className="settings-modal-header">
          <h2 id="settings-modal-title" className="settings-modal-title">
            Settings
          </h2>
          <button
            type="button"
            className="settings-modal-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="settings-modal-body">
          <SettingsLayout client={client} />
        </div>
      </div>
    </div>
  );
}
