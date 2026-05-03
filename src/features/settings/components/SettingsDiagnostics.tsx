import type {
  IndexStatus,
  ModelsStatus,
  SearchSettings,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import { PROVIDER_PRESETS } from "../data/providerPresets";

/**
 * 4-cell summary card at the bottom of the Settings page —
 * mirror of the prototype's Diagnostics block. Computes
 * configured-providers, ready models, and indexed chunks from the
 * envelopes the page already loads, so it adds no new RPCs.
 */
export function SettingsDiagnostics({
  settings,
  indexing,
  models,
}: {
  settings: SearchSettings;
  indexing: SidecarEnvelope<IndexStatus> | null;
  models: SidecarEnvelope<ModelsStatus> | null;
}) {
  const totalProviders = PROVIDER_PRESETS.length;
  const configuredProviders = countConfigured(settings);

  const modelData =
    models && models.state === "ready" && models.data ? models.data : null;
  const readyModels = modelData
    ? Object.values(modelData.roles).filter((r) => r.state === "ready").length
    : null;
  const totalRoles = modelData ? Object.values(modelData.roles).length : null;

  const indexData =
    indexing && indexing.state === "ready" && indexing.data
      ? indexing.data
      : null;

  return (
    <section className="settings-diag" aria-label="Diagnostics summary">
      <header className="settings-diag-head">
        <h2 className="settings-diag-title">Diagnostics</h2>
        <span className="settings-diag-version">CogniOS</span>
      </header>
      <div className="settings-diag-grid">
        <div className="settings-diag-cell">
          <div className="k">Engines</div>
          <div className="v">
            {configuredProviders}
            <span className="suffix"> / {totalProviders}</span>
          </div>
          <div className="sub">configured</div>
          <div className="bar">
            <i
              style={{
                width: `${(configuredProviders / totalProviders) * 100}%`,
              }}
            />
          </div>
        </div>

        <div className="settings-diag-cell">
          <div className="k">Model roles</div>
          <div className="v">
            {readyModels ?? "—"}
            {totalRoles !== null ? (
              <span className="suffix"> / {totalRoles}</span>
            ) : null}
          </div>
          <div className="sub">
            {modelData ? "roles ready" : "loading…"}
          </div>
        </div>

        <div className="settings-diag-cell">
          <div className="k">Indexed items</div>
          <div className="v">
            {indexData ? indexData.indexedChunks.toLocaleString() : "—"}
          </div>
          <div className="sub">
            {indexData
              ? `${indexData.queueDepth} queued`
              : "loading…"}
          </div>
        </div>

        <div className="settings-diag-cell">
          <div className="k">In flight</div>
          <div className="v">{indexData ? indexData.inFlight.length : "—"}</div>
          <div className="sub">jobs running</div>
        </div>
      </div>
    </section>
  );
}

function countConfigured(settings: SearchSettings): number {
  return PROVIDER_PRESETS.reduce((count, preset) => {
    if (preset.authKind === "none") return count + 1;
    return settings.providers[preset.providerId] !== undefined
      ? count + 1
      : count;
  }, 0);
}
