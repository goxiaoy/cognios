import { useEffect, useState } from "react";

import type {
  ProviderConfig,
  SearchSettings,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { ProviderPreset } from "../data/providerPresets";
import { CloudEgressConsentDialog } from "./CloudEgressConsentDialog";

/**
 * Per-provider editor — used both inline from a feature row and from
 * the Providers section. Manages the API key entry state machine
 * (idle → editing → validating → error/saved) and persists changes
 * via the SearchClient + provider-secret IPC commands.
 */
type EditorState =
  | { kind: "idle" }
  | { kind: "editing" }
  | { kind: "validating" }
  | { kind: "error"; message: string }
  | { kind: "saved" };

export function ProviderEditor({
  preset,
  config,
  settings,
  client,
  onSettingsChange,
  onClose,
  onKeyPresenceChange,
}: {
  preset: ProviderPreset;
  config: ProviderConfig | null;
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
  onClose: () => void;
  /** Optimistic notification to the parent section so it can update
   * its key-presence map without re-probing the keychain (which
   * would prompt the user on macOS after a binary rebuild). */
  onKeyPresenceChange?: (providerId: string, present: boolean) => void;
}) {
  const [state, setState] = useState<EditorState>({ kind: "idle" });
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState<boolean>(false);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? preset.baseUrl ?? "");
  const [modelPerCapability, setModelPerCapability] = useState<
    Record<string, string>
  >({
    ...preset.defaultModelPerCapability,
    ...(config?.modelPerCapability ?? {}),
  });
  const [pendingSecretForConsent, setPendingSecretForConsent] = useState<
    string | null
  >(null);
  const canEditConfig = preset.authKind === "none" && Boolean(preset.baseUrl);

  useEffect(() => {
    if (preset.authKind !== "api-key") {
      setHasSecret(false);
      return;
    }
    let cancelled = false;
    void client
      .hasProviderSecret({ providerId: preset.providerId })
      .then((present) => {
        if (!cancelled) setHasSecret(present);
      })
      .catch(() => {
        if (!cancelled) setHasSecret(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, preset.authKind, preset.providerId]);

  function handleSave() {
    // Cloud-egress consent gate: if this is a cloud provider the
    // user hasn't acked yet, prompt before any keychain or settings
    // mutation. Already-acked providers (or local providers) skip
    // the dialog and persist immediately.
    if (
      preset.providerType === "cloud" &&
      !settings.cloudConsentAcked.includes(preset.providerId)
    ) {
      setPendingSecretForConsent(secret);
      return;
    }
    void persistKey(secret, settings.cloudConsentAcked);
  }

  async function persistKey(theSecret: string, cloudConsentAcked: string[]) {
    setState({ kind: "validating" });
    try {
      await client.setProviderSecret({
        providerId: preset.providerId,
        secret: theSecret,
      });
      const nextProviders: SearchSettings["providers"] = {
        ...settings.providers,
        [preset.providerId]: {
          providerId: preset.providerId,
          enabled: true,
          apiKeyRef: `keychain://cognios-search/provider:${preset.providerId}`,
          baseUrl: config?.baseUrl ?? null,
          modelPerCapability: config?.modelPerCapability ?? {},
        },
      };
      const env = await client.updateSettings({
        ...settings,
        providers: nextProviders,
        cloudConsentAcked,
      });
      if (env.state !== "ready" || !env.data) {
        setState({
          kind: "error",
          message: env.error ?? "Failed to persist settings.",
        });
        return;
      }
      onSettingsChange(env.data);
      setHasSecret(true);
      onKeyPresenceChange?.(preset.providerId, true);
      setSecret("");
      setState({ kind: "saved" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleRemove() {
    setState({ kind: "validating" });
    try {
      await client.deleteProviderSecret({ providerId: preset.providerId });
      const { [preset.providerId]: _, ...rest } = settings.providers;
      const env = await client.updateSettings({
        ...settings,
        providers: rest,
      });
      if (env.state !== "ready" || !env.data) {
        setState({
          kind: "error",
          message: env.error ?? "Failed to persist settings.",
        });
        return;
      }
      onSettingsChange(env.data);
      setHasSecret(false);
      onKeyPresenceChange?.(preset.providerId, false);
      onClose();
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSaveConfig() {
    setState({ kind: "validating" });
    try {
      const nextProviders: SearchSettings["providers"] = {
        ...settings.providers,
        [preset.providerId]: {
          providerId: preset.providerId,
          enabled: true,
          apiKeyRef: config?.apiKeyRef ?? null,
          baseUrl: baseUrl.trim() || null,
          modelPerCapability: Object.fromEntries(
            Object.entries(modelPerCapability).map(([capability, model]) => [
              capability,
              model.trim(),
            ])
          ),
        },
      };
      const env = await client.updateSettings({
        ...settings,
        providers: nextProviders,
      });
      if (env.state !== "ready" || !env.data) {
        setState({
          kind: "error",
          message: env.error ?? "Failed to persist settings.",
        });
        return;
      }
      onSettingsChange(env.data);
      setState({ kind: "saved" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="provider-editor" role="region" aria-label={preset.displayName}>
      {preset.authKind === "api-key" ? (
        <section className="provider-editor-section">
          {state.kind === "editing" || (!hasSecret && state.kind === "idle") ? (
            <label className="provider-editor-key-label">
              API key
              <input
                type="password"
                className="provider-editor-key-input"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={preset.apiKeyPrefix ?? ""}
                autoComplete="off"
              />
            </label>
          ) : (
            <p className="provider-editor-key-status">
              API key: {hasSecret ? "configured ✓" : "not set"}
              {hasSecret ? (
                <button
                  type="button"
                  className="provider-editor-edit-link"
                  onClick={() => setState({ kind: "editing" })}
                >
                  Edit
                </button>
              ) : null}
            </p>
          )}
        </section>
      ) : canEditConfig ? (
        <section className="provider-editor-section">
          <label className="provider-editor-key-label">
            Base URL
            <input
              type="url"
              className="provider-editor-key-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl ?? "http://127.0.0.1:11434"}
            />
          </label>
          {preset.capabilities.map((capability) => (
            <label key={capability} className="provider-editor-key-label">
              {capability} model
              <input
                type="text"
                className="provider-editor-key-input"
                value={modelPerCapability[capability] ?? ""}
                onChange={(e) =>
                  setModelPerCapability((current) => ({
                    ...current,
                    [capability]: e.target.value,
                  }))
                }
                placeholder={preset.defaultModelPerCapability[capability] ?? ""}
              />
            </label>
          ))}
        </section>
      ) : (
        <p className="provider-editor-info">
          No credentials required.
        </p>
      )}

      {state.kind === "validating" ? (
        <p className="muted-copy">Saving…</p>
      ) : null}
      {state.kind === "error" ? (
        <p className="settings-role-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "saved" ? (
        <p className="muted-copy">Saved ✓</p>
      ) : null}

      <div className="provider-editor-actions">
        {preset.authKind === "api-key" &&
        (state.kind === "editing" || (!hasSecret && state.kind === "idle")) ? (
          <button
            type="button"
            className="settings-action is-primary"
            disabled={!secret.trim()}
            onClick={() => void handleSave()}
          >
            Save
          </button>
        ) : null}
        {canEditConfig ? (
          <button
            type="button"
            className="settings-action is-primary"
            disabled={state.kind === "validating" || !baseUrl.trim()}
            onClick={() => void handleSaveConfig()}
          >
            Save
          </button>
        ) : null}
        {hasSecret ? (
          <button
            type="button"
            className="settings-action"
            onClick={() => void handleRemove()}
            disabled={state.kind === "validating"}
          >
            Remove key
          </button>
        ) : null}
      </div>

      {pendingSecretForConsent !== null ? (
        <CloudEgressConsentDialog
          preset={preset}
          onAccept={() => {
            const acked = preset.providerId;
            const nextAcked = settings.cloudConsentAcked.includes(acked)
              ? settings.cloudConsentAcked
              : [...settings.cloudConsentAcked, acked];
            void persistKey(pendingSecretForConsent, nextAcked);
            setPendingSecretForConsent(null);
          }}
          onCancel={() => setPendingSecretForConsent(null)}
        />
      ) : null}
    </div>
  );
}
