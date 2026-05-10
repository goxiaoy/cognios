import { useEffect, useState } from "react";

import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { useModelDownloadProgress } from "../hooks/useModelDownloadProgress";
import { useSearchSubsystemStatus } from "../hooks/useSearchSubsystemStatus";
import { FeaturesList } from "./FeaturesList";
import { ProvidersSection } from "./ProvidersSection";
import { RestartConfirmation } from "./RestartConfirmation";

/**
 * Primary Settings page. Renders the feature catalogue (with a
 * provider picker per feature) alongside the providers list — and
 * folds the per-model role state (downloaded / pending license /
 * error) directly into each local provider row, so users get a
 * single coherent surface instead of a separate "Diagnostics"
 * dashboard. The bottom strip shows aggregate counts.
 *
 * On settings change requiring a sidecar restart, a banner appears
 * with a button that opens RestartConfirmation; on confirm the
 * supervisor cycles, the new sidecar boots, and Settings re-fetches.
 */
export function SettingsLayout({ client }: { client: SearchClient }) {
  const { models } = useSearchSubsystemStatus(client);
  const progress = useModelDownloadProgress();
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [showRestart, setShowRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    // Poll while the sidecar is still ``initialising``. Without
    // this the Settings page sticks at "Loading settings…" if the
    // user opens it during sidecar boot — the previous version
    // handled ``ready`` and ``unavailable`` but silently fell
    // through on ``initialising``.
    const POLL_INTERVAL_MS = 500;

    async function attempt() {
      if (cancelled) return;
      try {
        const env = await client.settings();
        if (cancelled) return;
        if (env.state === "ready" && env.data) {
          setSettings(env.data);
          setError(null);
          return;
        }
        if (env.state === "initialising") {
          // Schedule another attempt; keep the spinner.
          timer = window.setTimeout(attempt, POLL_INTERVAL_MS);
          return;
        }
        // ``unavailable`` — try the Rust-side direct-disk fallback
        // so the user can at least see what's configured.
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
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void attempt();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client]);

  return (
    <section className="settings-layout" aria-label="Settings">
      <p className="settings-page-sub">
        Wire up the engines that power your knowledge base. Local providers
        run on this Mac; cloud providers go through your own keys.
      </p>

      {error ? (
        <p className="settings-role-error" role="alert">
          {error}
        </p>
      ) : null}

      {settings?.needsRestart ? (
        <div className="settings-restart-toast" role="status">
          <span className="settings-restart-toast-text">
            Settings changed — restart the sidecar to apply.
          </span>
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
        <>
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
              models={models}
              progress={progress}
            />
          </div>
        </>
      ) : (
        <p className="muted-copy">Loading settings…</p>
      )}

      {showRestart ? (
        <RestartConfirmation
          client={client}
          onClose={() => setShowRestart(false)}
          // The component polls until the new sidecar reports ready
          // and hands us the fresh state directly; if we re-fetched
          // here we'd race the boot and risk an ``initialising``
          // envelope leaving the stale ``needsRestart`` banner up.
          onRestarted={setSettings}
        />
      ) : null}
    </section>
  );
}
