import { useEffect, useRef } from "react";
import { Cloud, Cpu, X } from "lucide-react";

import type {
  ProviderConfig,
  SearchSettings,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { ProviderPreset } from "../data/providerPresets";
import { ProviderEditor } from "./ProviderEditor";

const CAPABILITY_LABEL: Record<string, string> = {
  embedding: "Embedding",
  reranking: "Reranking",
  vision: "Vision",
  ocr: "OCR",
};

/**
 * Modal sheet wrapper around :class:`ProviderEditor`. Replaces the
 * pre-Unit-13 inline expander with an overlay that matches the
 * Settings redesign — paper card with an avatar header, runtime/
 * capability subline, and a sticky-feel footer (the editor's own
 * Save / Remove key buttons sit below the form).
 *
 * Esc, click on backdrop, or the header X button close the sheet.
 */
export function ProviderEditorModal({
  preset,
  config,
  settings,
  client,
  onSettingsChange,
  onClose,
}: {
  preset: ProviderPreset;
  config: ProviderConfig | null;
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Restore focus to whatever was focused before the sheet opened.
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

  const RuntimeIcon = preset.providerType === "local" ? Cpu : Cloud;
  const capLabel = preset.capabilities
    .map((c) => CAPABILITY_LABEL[c] ?? c)
    .join(", ");
  const monogram = avatarText(preset);

  return (
    <div
      className="modal-overlay provider-modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="provider-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-modal-title"
      >
        <header className="provider-modal-head">
          <div className={`provider-avatar provider-avatar--${preset.providerType} provider-modal-avatar`}>
            {monogram}
          </div>
          <div className="provider-modal-head-text">
            <h2 id="provider-modal-title" className="provider-modal-title">
              {preset.displayName}
            </h2>
            <p className="provider-modal-sub">
              <span className="provider-modal-runtime">
                <RuntimeIcon size={11} aria-hidden="true" />
                {preset.providerType === "local" ? "Local" : "Cloud"}
              </span>
              <span className="provider-modal-sub-sep">·</span>
              <span>{capLabel}</span>
            </p>
          </div>
          <button
            type="button"
            className="provider-modal-close"
            aria-label="Close provider editor"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="provider-modal-body">
          <ProviderEditor
            preset={preset}
            config={config}
            settings={settings}
            client={client}
            onSettingsChange={onSettingsChange}
            onClose={onClose}
          />
          <p className="provider-modal-privacy">
            <span className="provider-modal-privacy-icon" aria-hidden="true" />
            <span>
              {preset.providerType === "local" ? (
                <>
                  <strong>Stays on this machine.</strong> Local providers run
                  entirely on your hardware and never reach the internet.
                </>
              ) : (
                <>
                  <strong>Stays on this machine.</strong> Credentials are
                  stored in the OS keychain. Outbound calls go directly from
                  your device to the provider.
                </>
              )}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function avatarText(preset: ProviderPreset): string {
  const stripped = preset.displayName.replace(/^Local\s+/, "");
  const parts = stripped.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
