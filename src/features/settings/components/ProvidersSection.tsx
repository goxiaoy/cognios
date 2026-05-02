import { useEffect, useState } from "react";

import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { PROVIDER_PRESETS, ProviderPreset } from "../data/providerPresets";
import { ProviderEditor } from "./ProviderEditor";

/**
 * Always-visible Providers section. Lists every preset (configured
 * or not) with an Add/Edit affordance. Acts as the dedicated home
 * for provider management — power users come here directly rather
 * than threading through a feature row.
 */
export function ProvidersSection({
  settings,
  client,
  onSettingsChange,
}: {
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});

  // Probe key presence for cloud providers so the row's "configured"
  // indicator reflects the OS keychain truth, not just whether
  // settings.json has the provider entry.
  useEffect(() => {
    const cloudIds = PROVIDER_PRESETS.filter(
      (p) => p.authKind === "api-key"
    ).map((p) => p.providerId);
    let cancelled = false;
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
  }, [client, settings.providers, openId]);

  return (
    <div className="settings-card">
      <h2 className="settings-card-title">Providers</h2>
      <ul className="providers-list">
        {PROVIDER_PRESETS.map((preset) => (
          <ProviderRow
            key={preset.providerId}
            preset={preset}
            isConfigured={isProviderConfigured(preset, settings, keyPresence)}
            isOpen={openId === preset.providerId}
            onToggle={() =>
              setOpenId(
                openId === preset.providerId ? null : preset.providerId
              )
            }
          />
        ))}
      </ul>
      {openId
        ? (() => {
            const preset = PROVIDER_PRESETS.find(
              (p) => p.providerId === openId
            );
            if (!preset) return null;
            return (
              <ProviderEditor
                preset={preset}
                config={settings.providers[openId] ?? null}
                settings={settings}
                client={client}
                onSettingsChange={onSettingsChange}
                onClose={() => setOpenId(null)}
              />
            );
          })()
        : null}
    </div>
  );
}

function isProviderConfigured(
  preset: ProviderPreset,
  settings: SearchSettings,
  keyPresence: Record<string, boolean>
): boolean {
  if (preset.authKind === "none") {
    return true;
  }
  if (preset.authKind === "api-key") {
    return keyPresence[preset.providerId] ?? false;
  }
  return settings.providers[preset.providerId] !== undefined;
}

function ProviderRow({
  preset,
  isConfigured,
  isOpen,
  onToggle,
}: {
  preset: ProviderPreset;
  isConfigured: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="provider-row">
      <div className="provider-row-meta">
        <span className="provider-row-name">{preset.displayName}</span>
        <span className="provider-row-type">
          {preset.providerType === "local" ? "Local" : "Cloud"} ·{" "}
          {preset.capabilities.join(", ")}
        </span>
      </div>
      <div className="provider-row-actions">
        <span
          className={`provider-row-status ${
            isConfigured ? "is-configured" : "is-empty"
          }`}
        >
          {isConfigured ? "Configured" : "Not configured"}
        </span>
        <button
          type="button"
          className="settings-action"
          onClick={onToggle}
          aria-expanded={isOpen}
        >
          {isOpen ? "Close" : isConfigured ? "Edit" : "Add"}
        </button>
      </div>
    </li>
  );
}
