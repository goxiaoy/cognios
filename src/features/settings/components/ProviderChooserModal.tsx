import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Cpu, X } from "lucide-react";

import type { SearchClient } from "../../search/types/search";
import {
  Capability,
  FeatureMeta,
  ProviderPreset,
} from "../data/providerPresets";

const CAPABILITY_LABEL: Record<Capability, string> = {
  embedding: "Embedding",
  reranking: "Reranking",
  vision: "Vision",
  ocr: "OCR",
  "advanced-ocr": "Advanced OCR",
  chat: "Chat",
  "web-search": "Web Search",
};

/**
 * Modal sheet that lets the user pick which provider powers a
 * feature — opens from the FeatureRow's provider pill. Replaces the
 * pre-Unit-13 native <select>; matches the redesigned ProviderSheet
 * styling (paper card, avatar header, radio list, sticky footer).
 *
 * On confirm, calls ``onChoose(providerId)`` — the caller is
 * responsible for routing through any consent gates (e.g., cloud
 * egress) before persisting via SearchClient.
 */
export function ProviderChooserModal({
  feature,
  providers,
  currentProviderId,
  client,
  onClose,
  onChoose,
}: {
  feature: FeatureMeta;
  providers: readonly ProviderPreset[];
  currentProviderId: string | null;
  client: SearchClient;
  onClose: () => void;
  onChoose: (providerId: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(currentProviderId);
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});

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

  // Probe key presence for cloud providers so the radio rows can
  // show a "needs setup" hint without the user having to navigate
  // away. Local providers don't need a probe (authKind === "none").
  useEffect(() => {
    let cancelled = false;
    const cloudIds = providers
      .filter((p) => p.authKind === "api-key")
      .map((p) => p.providerId);
    void Promise.all(
      cloudIds.map((id) =>
        client
          .hasProviderSecret({ providerId: id })
          .then((present) => [id, present] as const)
          .catch(() => [id, false] as const)
      )
    ).then((entries) => {
      if (cancelled) return;
      setKeyPresence(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [client, providers]);

  function handleConfirm() {
    if (!selected) return;
    onChoose(selected);
  }

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
        className="provider-modal provider-chooser-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-chooser-title"
      >
        <header className="provider-modal-head provider-chooser-head">
          <div className="provider-modal-head-text">
            <h2
              id="provider-chooser-title"
              className="provider-modal-title"
            >
              Choose provider for {feature.displayName}
            </h2>
            <p className="provider-modal-sub">
              Pick the engine that powers this feature. You can change this
              any time.
            </p>
          </div>
          <button
            type="button"
            className="provider-modal-close"
            aria-label="Close provider chooser"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="provider-modal-body provider-chooser-body">
          <ul
            className="provider-choice-list"
            role="radiogroup"
            aria-labelledby="provider-chooser-title"
          >
            {providers.map((preset) => (
              <ProviderChoiceRow
                key={preset.providerId}
                preset={preset}
                selected={selected === preset.providerId}
                isConfigured={isConfigured(preset, keyPresence)}
                onSelect={() => setSelected(preset.providerId)}
              />
            ))}
            {providers.length === 0 ? (
              <li className="providers-empty">
                No providers advertise this capability.
              </li>
            ) : null}
          </ul>
        </div>

        <footer className="provider-modal-foot">
          <button
            type="button"
            className="settings-action"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="settings-action is-primary"
            disabled={!selected || selected === currentProviderId}
            onClick={handleConfirm}
          >
            <Check size={12} aria-hidden="true" /> Use this provider
          </button>
        </footer>
      </div>
    </div>
  );
}

function isConfigured(
  preset: ProviderPreset,
  keyPresence: Record<string, boolean>
): boolean {
  if (preset.authKind === "none") return true;
  if (preset.authKind === "api-key") return keyPresence[preset.providerId] ?? false;
  return false;
}

function rowDisplayName(preset: ProviderPreset): string {
  return preset.displayName.replace(/^Local\s+/, "");
}

function avatarText(preset: ProviderPreset): string {
  const parts = rowDisplayName(preset).split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ProviderChoiceRow({
  preset,
  selected,
  isConfigured,
  onSelect,
}: {
  preset: ProviderPreset;
  selected: boolean;
  isConfigured: boolean;
  onSelect: () => void;
}) {
  const RuntimeIcon = preset.providerType === "local" ? Cpu : Cloud;
  const capLabel = preset.capabilities
    .map((c) => CAPABILITY_LABEL[c])
    .join(", ");

  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className={`provider-choice${selected ? " is-selected" : ""}`}
        onClick={onSelect}
      >
        <span className="provider-choice-radio" aria-hidden="true" />
        <span className="provider-choice-text">
          <span className="provider-choice-name">
            {rowDisplayName(preset)}
          </span>
          <span className="provider-choice-sub">
            <span className="provider-choice-runtime">
              <RuntimeIcon size={11} aria-hidden="true" />
              {preset.providerType === "local" ? "Local" : "Cloud"}
            </span>
            <span className="provider-choice-sep">·</span>
            <span>{capLabel}</span>
            {!isConfigured ? (
              <>
                <span className="provider-choice-sep">·</span>
                <span className="provider-choice-warn">needs setup</span>
              </>
            ) : null}
          </span>
        </span>
        <span
          className={`provider-avatar provider-avatar--${preset.providerType} provider-choice-avatar`}
          aria-hidden="true"
        >
          {avatarText(preset)}
        </span>
      </button>
    </li>
  );
}
