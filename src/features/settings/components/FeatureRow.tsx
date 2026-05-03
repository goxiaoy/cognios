import { useState } from "react";
import {
  ChevronDown,
  FileSearch,
  Image as ImageIcon,
  Layers,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";

import type {
  FeatureConfig,
  SearchSettings,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import {
  FeatureMeta,
  presetById,
  presetOwnsRole,
  presetsWithCapability,
  ProviderPreset,
} from "../data/providerPresets";
import { CloudEgressConsentDialog } from "./CloudEgressConsentDialog";
import { ProviderChooserModal } from "./ProviderChooserModal";

const FEATURE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  "semantic-search": Search,
  "result-reranking": Layers,
  "image-ocr": ImageIcon,
  "image-captioning": Sparkles,
  "advanced-ocr": FileSearch,
};

/**
 * One feature row. Renders the enable toggle (or "Required" badge
 * for mandatory features) and a provider-pill picker filtered by
 * the feature's capability. Credentials editing happens from the
 * Providers column on the right — there is no inline editor here.
 *
 * Phase-2 features (image-captioning) render disabled with an
 * "available in next release" hint when ``comingSoon`` is true —
 * the row stays in the UI so users see the conceptual model, but
 * the toggle can't flip on until the extractor wiring lands.
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
  const [pendingConsentFor, setPendingConsentFor] = useState<
    ProviderPreset | null
  >(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const compatible = presetsWithCapability(meta.capability);
  const enabled = config?.enabled ?? meta.mandatory;
  const boundProviderId = config?.providerId ?? null;
  const boundPreset = boundProviderId ? presetById(boundProviderId) : undefined;
  const Icon = FEATURE_ICON[meta.featureId] ?? Sparkles;
  const pillDisplayName = boundPreset
    ? boundPreset.displayName.replace(/^Local\s+/, "")
    : null;

  async function handleToggle() {
    if (meta.mandatory) return;
    const wasEnabled = enabled;
    // Keep the provider binding sticky across enable/disable —
    // clearing it on disable made the card height jump (the
    // "via <provider>" meta row collapsed) and lost the user's
    // earlier choice. The meta row stays visible-but-muted when
    // disabled, so we hold the binding even at rest.
    const nextFeatures: SearchSettings["features"] = {
      ...settings.features,
      [meta.featureId]: {
        enabled: !enabled,
        providerId: config?.providerId ?? null,
      },
    };
    const env = await client.updateSettings({
      ...settings,
      features: nextFeatures,
    });
    if (env.state === "ready" && env.data) {
      onSettingsChange(env.data);
      // Just-enabled with a local provider already bound? Kick off
      // any missing model downloads so the user doesn't have to
      // chase 13 download buttons in the Providers column.
      if (!wasEnabled && config?.providerId) {
        void kickoffMissingDownloads(config.providerId);
      }
    }
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
    if (env.state === "ready" && env.data) {
      onSettingsChange(env.data);
      // Bound a local provider? Kick off any missing stages so the
      // user doesn't have to chase per-stage download buttons —
      // particularly important for PP-StructureV3 (13 stages).
      if (next) void kickoffMissingDownloads(next);
    }
  }

  /** Fire ``startModelDownload`` for every role this preset owns
   * whose state isn't already ``ready`` / ``downloading``. Quiet
   * on failure — the DownloadDock surfaces persistent errors via
   * the polled models envelope. No-op for cloud providers and
   * for local providers that ship their models bundled (rapidocr).
   */
  async function kickoffMissingDownloads(providerId: string): Promise<void> {
    const preset = presetById(providerId);
    if (!preset || preset.providerType !== "local" || !preset.localRoleId) {
      return;
    }
    try {
      const env = await client.modelsStatus();
      if (env.state !== "ready" || !env.data) return;
      for (const [roleId, status] of Object.entries(env.data.roles)) {
        if (!presetOwnsRole(preset, roleId)) continue;
        if (status.state === "ready" || status.state === "downloading") {
          continue;
        }
        try {
          await client.startModelDownload({ role: roleId });
        } catch {
          /* swallow — dock surfaces the error via polled state */
        }
      }
    } catch {
      /* models_status unavailable — user can retry from Settings */
    }
  }

  return (
    <li
      className={`feature-card${enabled ? " is-enabled" : ""}`}
      aria-label={meta.displayName}
    >
      <div className="feature-card-icon">
        <Icon size={16} />
      </div>
      <div className="feature-card-body">
        <div className="feature-card-name">
          <span className="feature-row-name">{meta.displayName}</span>
          {meta.mandatory ? (
            <span className="feature-badge feature-badge--required">Required</span>
          ) : null}
          {meta.comingSoon ? (
            <span className="feature-badge feature-badge--soon">
              coming soon
            </span>
          ) : null}
        </div>
        <p className="feature-card-blurb feature-row-description">
          {meta.description}
        </p>
        {!meta.comingSoon ? (
          <div className="feature-card-meta">
            <span className="feature-card-via">via</span>
            <button
              type="button"
              className={`feature-provider-pill${
                boundPreset?.providerType === "cloud" ? " is-cloud" : " is-local"
              }${boundProviderId ? "" : " is-unset"}${
                enabled ? "" : " is-muted"
              }`}
              onClick={() => setChooserOpen(true)}
              aria-haspopup="dialog"
              aria-label={
                boundPreset
                  ? `Change provider for ${meta.displayName}`
                  : `Choose provider for ${meta.displayName}`
              }
            >
              {boundProviderId ? (
                <>
                  <span
                    className="feature-provider-runtime-dot"
                    aria-hidden="true"
                  />
                  <span className="feature-provider-name">
                    {pillDisplayName}
                  </span>
                  <ChevronDown size={11} aria-hidden="true" />
                </>
              ) : (
                <>
                  <Plus size={11} aria-hidden="true" />
                  <span className="feature-provider-name">Choose provider</span>
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>
      <div className="feature-card-toggle">
        {meta.mandatory ? (
          <span
            className="feature-row-required-badge"
            aria-hidden="true"
          />
        ) : meta.comingSoon ? null : (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`feature-toggle ${enabled ? "is-on" : "is-off"} feature-row-toggle-button`}
            onClick={() => void handleToggle()}
          >
            <span className="sr-only">{enabled ? "On" : "Off"}</span>
          </button>
        )}
      </div>

      {chooserOpen ? (
        <ProviderChooserModal
          feature={meta}
          providers={compatible}
          currentProviderId={boundProviderId}
          client={client}
          onClose={() => setChooserOpen(false)}
          onChoose={(providerId) => {
            setChooserOpen(false);
            void handleProviderChange(providerId);
          }}
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
