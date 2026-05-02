import { useState } from "react";

import type {
  FeatureConfig,
  SearchSettings,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import {
  FeatureMeta,
  presetById,
  presetsWithCapability,
  ProviderPreset,
} from "../data/providerPresets";
import { CloudEgressConsentDialog } from "./CloudEgressConsentDialog";
import { ProviderEditor } from "./ProviderEditor";

/**
 * One feature row. Renders enable toggle (or "Required" badge for
 * mandatory features), provider picker filtered by the feature's
 * capability, and an inline ProviderEditor when the user opens it.
 *
 * Phase-2 features (image-ocr, image-captioning) render disabled
 * with an "available in next release" hint — the row is in the UI
 * so users see the conceptual model, but the toggle can't flip on
 * until the extractor wiring lands.
 */
export function FeatureRow({
  meta,
  config,
  settings,
  client,
  onSettingsChange,
}: {
  meta: FeatureMeta;
  config: FeatureConfig | undefined;
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
}) {
  const [editorOpenFor, setEditorOpenFor] = useState<string | null>(null);
  const [pendingConsentFor, setPendingConsentFor] = useState<
    ProviderPreset | null
  >(null);
  const compatible = presetsWithCapability(meta.capability);
  const enabled = config?.enabled ?? meta.mandatory;
  const boundProviderId = config?.providerId ?? null;
  const boundPreset = boundProviderId ? presetById(boundProviderId) : undefined;

  async function handleToggle() {
    if (meta.mandatory) return;
    const nextFeatures: SearchSettings["features"] = {
      ...settings.features,
      [meta.featureId]: {
        enabled: !enabled,
        providerId: !enabled ? config?.providerId ?? null : null,
      },
    };
    const env = await client.updateSettings({
      ...settings,
      features: nextFeatures,
    });
    if (env.state === "ready" && env.data) onSettingsChange(env.data);
  }

  async function handleProviderChange(nextId: string) {
    const next = nextId === "" ? null : nextId;
    // Cloud-egress consent gate: first time the user binds *any*
    // feature to a cloud provider, intercept and prompt before the
    // PUT lands. Already-acked providers pass through silently.
    if (next) {
      const preset = presetById(next);
      if (
        preset?.providerType === "cloud" &&
        !settings.cloudConsentAcked.includes(next)
      ) {
        setPendingConsentFor(preset);
        return;
      }
    }
    await commitProviderChange(next, settings.cloudConsentAcked);
  }

  async function commitProviderChange(
    next: string | null,
    cloudConsentAcked: string[]
  ) {
    const nextFeatures: SearchSettings["features"] = {
      ...settings.features,
      [meta.featureId]: {
        enabled: enabled,
        providerId: next,
      },
    };
    const env = await client.updateSettings({
      ...settings,
      features: nextFeatures,
      cloudConsentAcked,
    });
    if (env.state === "ready" && env.data) onSettingsChange(env.data);
  }

  return (
    <li className="feature-row" aria-label={meta.displayName}>
      <div className="feature-row-header">
        <div className="feature-row-meta">
          <span className="feature-row-name">{meta.displayName}</span>
          <span className="feature-row-description">{meta.description}</span>
        </div>
        <div className="feature-row-toggle">
          {meta.mandatory ? (
            <span className="feature-row-required-badge">Required</span>
          ) : meta.comingSoon ? (
            <span
              className="feature-row-coming-soon"
              title="Available in the next release"
            >
              coming soon
            </span>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              className={`feature-row-toggle-button ${enabled ? "is-on" : "is-off"}`}
              onClick={() => void handleToggle()}
            >
              {enabled ? "On" : "Off"}
            </button>
          )}
        </div>
      </div>

      {enabled && !meta.comingSoon ? (
        <div className="feature-row-body">
          <label className="feature-row-provider-label">
            Provider
            <select
              className="feature-row-provider-picker"
              value={boundProviderId ?? ""}
              onChange={(e) => void handleProviderChange(e.target.value)}
            >
              <option value="">— pick one —</option>
              {compatible.map((preset) => (
                <option key={preset.providerId} value={preset.providerId}>
                  {preset.displayName}
                  {preset.providerType === "cloud" ? " (cloud)" : ""}
                </option>
              ))}
            </select>
          </label>
          {boundPreset ? (
            <button
              type="button"
              className="settings-action"
              onClick={() =>
                setEditorOpenFor(
                  editorOpenFor === boundPreset.providerId
                    ? null
                    : boundPreset.providerId
                )
              }
            >
              {editorOpenFor === boundPreset.providerId ? "Hide" : "Edit"} provider
            </button>
          ) : null}
        </div>
      ) : null}

      {editorOpenFor && boundPreset && editorOpenFor === boundPreset.providerId ? (
        <ProviderEditor
          preset={boundPreset}
          config={settings.providers[boundPreset.providerId] ?? null}
          settings={settings}
          client={client}
          onSettingsChange={onSettingsChange}
          onClose={() => setEditorOpenFor(null)}
        />
      ) : null}

      {pendingConsentFor ? (
        <CloudEgressConsentDialog
          preset={pendingConsentFor}
          onAccept={() => {
            const acked = pendingConsentFor.providerId;
            const nextAcked = settings.cloudConsentAcked.includes(acked)
              ? settings.cloudConsentAcked
              : [...settings.cloudConsentAcked, acked];
            void commitProviderChange(acked, nextAcked);
            setPendingConsentFor(null);
          }}
          onCancel={() => setPendingConsentFor(null)}
        />
      ) : null}
    </li>
  );
}
