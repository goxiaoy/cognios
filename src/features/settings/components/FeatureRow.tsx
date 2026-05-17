import { useState } from "react";
import {
  ChevronDown,
  FileSearch,
  Globe,
  Image as ImageIcon,
  Layers,
  MessageCircle,
  Mic,
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
import { ProviderEditorModal } from "./ProviderEditorModal";

const FEATURE_ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  "semantic-search": Search,
  "result-reranking": Layers,
  "image-ocr": ImageIcon,
  "image-captioning": Sparkles,
  "advanced-ocr": FileSearch,
  chat: MessageCircle,
  "voice-notes": Mic,
  "web-search": Globe,
};

/**
 * One feature row. Renders the enable toggle for optional features
 * and a provider-pill picker filtered by the feature's capability.
 * Credentials editing happens from the
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
    { preset: ProviderPreset; enableOnCommit: boolean } | null
  >(null);
  const [pendingSetupFor, setPendingSetupFor] = useState<
    { preset: ProviderPreset; enableOnCommit: boolean } | null
  >(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [enableOnProviderPick, setEnableOnProviderPick] = useState(false);
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
    if (!wasEnabled && !boundProviderId) {
      setEnableOnProviderPick(true);
      setChooserOpen(true);
      return;
    }
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

  async function handleProviderChange(
    nextId: string,
    enableOnCommit = false,
    isProviderConfigured = true
  ) {
    const next = nextId === "" ? null : nextId;
    if (next && !isProviderConfigured) {
      const preset = presetById(next);
      if (preset) setPendingSetupFor({ preset, enableOnCommit });
      return;
    }
    // Cloud-egress consent gate: first time the user binds *any*
    // feature to a cloud provider, intercept and prompt before the
    // PUT lands. Already-acked providers pass through silently.
    if (next) {
      const preset = presetById(next);
      if (
        preset?.providerType === "cloud" &&
        !settings.cloudConsentAcked.includes(next)
      ) {
        setPendingConsentFor({ preset, enableOnCommit });
        return;
      }
    }
    await commitProviderChange(next, settings.cloudConsentAcked, enableOnCommit);
  }

  async function commitProviderChange(
    next: string | null,
    cloudConsentAcked: string[],
    enableOnCommit = false
  ) {
    const nextFeatures: SearchSettings["features"] = {
      ...settings.features,
      [meta.featureId]: {
        enabled: enableOnCommit ? true : enabled,
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
      // Fire in parallel — each ``startModelDownload`` returns a
      // Promise that only resolves when the SSE stream closes (i.e.
      // download completes). Awaiting in sequence would serialize
      // 13 PP-StructureV3 stages and bypass the sidecar's
      // concurrency-cap+queue logic; instead, fire-and-forget so the
      // sidecar sees all requests at once and parks the excess on
      // its semaphore (emitting ``queued`` frames the dock surfaces).
      for (const [roleId, status] of Object.entries(env.data.roles)) {
        if (!presetOwnsRole(preset, roleId)) continue;
        if (status.state === "ready" || status.state === "downloading") {
          continue;
        }
        void client.startModelDownload({ role: roleId }).catch(() => {
          /* swallow — dock surfaces the error via polled state */
        });
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
          settings={settings}
          client={client}
          onClose={() => {
            setChooserOpen(false);
            setEnableOnProviderPick(false);
          }}
          onChoose={(providerId, isConfigured) => {
            setChooserOpen(false);
            const shouldEnable = enableOnProviderPick;
            setEnableOnProviderPick(false);
            void handleProviderChange(providerId, shouldEnable, isConfigured);
          }}
        />
      ) : null}

      {pendingSetupFor ? (
        <ProviderEditorModal
          preset={pendingSetupFor.preset}
          config={settings.providers[pendingSetupFor.preset.providerId] ?? null}
          settings={settingsWithFeatureBinding(
            settings,
            meta.featureId,
            pendingSetupFor.preset.providerId,
            pendingSetupFor.enableOnCommit ? true : enabled
          )}
          client={client}
          onSettingsChange={(next) => {
            onSettingsChange(next);
            void kickoffMissingDownloads(pendingSetupFor.preset.providerId);
          }}
          onClose={() => setPendingSetupFor(null)}
        />
      ) : null}

      {pendingConsentFor ? (
        <CloudEgressConsentDialog
          preset={pendingConsentFor.preset}
          onAccept={() => {
            const acked = pendingConsentFor.preset.providerId;
            const nextAcked = settings.cloudConsentAcked.includes(acked)
              ? settings.cloudConsentAcked
              : [...settings.cloudConsentAcked, acked];
            void commitProviderChange(
              acked,
              nextAcked,
              pendingConsentFor.enableOnCommit
            );
            setPendingConsentFor(null);
          }}
          onCancel={() => setPendingConsentFor(null)}
        />
      ) : null}
    </li>
  );
}

function settingsWithFeatureBinding(
  settings: SearchSettings,
  featureId: string,
  providerId: string,
  enabled: boolean
): SearchSettings {
  return {
    ...settings,
    features: {
      ...settings.features,
      [featureId]: {
        enabled,
        providerId,
      },
    },
  };
}
