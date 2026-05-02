import { useEffect, useState } from "react";

import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { useModelDownloadProgress } from "../hooks/useModelDownloadProgress";
import { useSearchSubsystemStatus } from "../hooks/useSearchSubsystemStatus";
import { FeaturesList } from "./FeaturesList";
import { IndexingStatusCard } from "./IndexingStatusCard";
import { ModelManagerStatus } from "./ModelManagerStatus";
import { ProvidersSection } from "./ProvidersSection";
import { RestartConfirmation } from "./RestartConfirmation";

/**
 * Primary Settings page. Replaces the old "Models" card with the
 * feature-vocabulary view: Features list (with provider pickers per
 * feature) + Providers section (always visible). The legacy
 * ModelManagerStatus + IndexingStatusCard are reachable as a
 * "Diagnostics" sub-section so power users keep the inspect surface.
 *
 * On settings change requiring a sidecar restart, a banner appears
 * with a button that opens RestartConfirmation; on confirm the
 * supervisor cycles, the new sidecar boots, and Settings re-fetches.
 */
export function SettingsLayout({ client }: { client: SearchClient }) {
  const { models, indexing } = useSearchSubsystemStatus(client);
  const progress = useModelDownloadProgress();
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showRestart, setShowRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const env = await client.settings();
        if (cancelled) return;
        if (env.state === "ready" && env.data) {
          setSettings(env.data);
          setError(null);
        } else if (env.state === "unavailable") {
          // Try the Rust-side fallback so the user can at least see
          // what's configured.
          try {
            const fallback = await client.readSettingsFallback();
            if (!cancelled) {
              setSettings(fallback);
              setError("Sidecar unavailable — settings shown read-only.");
            }
          } catch {
            if (!cancelled) {
              setError(env.error ?? "Settings unavailable.");
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <section className="settings-layout" aria-label="Settings">
      <header className="settings-header">
        <button
          type="button"
          className="settings-diagnostics-link"
          aria-pressed={showDiagnostics}
          onClick={() => setShowDiagnostics((v) => !v)}
        >
          {showDiagnostics ? "Hide" : "Show"} Diagnostics
        </button>
      </header>

      {error ? (
        <p className="settings-role-error" role="alert">
          {error}
        </p>
      ) : null}

      {settings?.needsRestart ? (
        <div className="settings-restart-banner" role="status">
          <span>Settings changed — restart the sidecar to apply.</span>
          <button
            type="button"
            className="settings-action is-primary"
            onClick={() => setShowRestart(true)}
          >
            Restart sidecar
          </button>
        </div>
      ) : null}

      {settings ? (
        <div className="settings-grid">
          <FeaturesList
            settings={settings}
            client={client}
            onSettingsChange={setSettings}
          />
          <ProvidersSection
            settings={settings}
            client={client}
            onSettingsChange={setSettings}
          />
        </div>
      ) : (
        <p className="muted-copy">Loading settings…</p>
      )}

      {showDiagnostics ? (
        <div className="settings-grid settings-diagnostics">
          <h2 className="settings-card-title">Diagnostics</h2>
          <ModelManagerStatus
            envelope={models}
            client={client}
            progress={progress}
          />
          <IndexingStatusCard envelope={indexing} />
        </div>
      ) : null}

      {showRestart ? (
        <RestartConfirmation
          client={client}
          onClose={() => {
            setShowRestart(false);
            // After restart, re-fetch settings (needsRestart should clear).
            void client.settings().then((env) => {
              if (env.state === "ready" && env.data) setSettings(env.data);
            });
          }}
        />
      ) : null}
    </section>
  );
}
