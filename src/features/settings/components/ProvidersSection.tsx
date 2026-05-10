import { useEffect, useMemo, useState } from "react";
import { Cloud, Cpu } from "lucide-react";

import type {
  ModelDownloadEvent,
  ModelRoleStatus,
  ModelsStatus,
  SearchSettings,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import {
  Capability,
  PROVIDER_PRESETS,
  presetOwnsRole,
  ProviderPreset,
} from "../data/providerPresets";
import type { ProgressByRole } from "../hooks/useModelDownloadProgress";
import { ProviderEditorModal } from "./ProviderEditorModal";
import { ProviderStagesModal } from "./ProviderStagesModal";

const CAPABILITY_LABEL: Record<Capability, string> = {
  embedding: "Embedding",
  reranking: "Reranking",
  vision: "Vision",
  ocr: "OCR",
  "advanced-ocr": "Advanced OCR",
  chat: "Chat",
  "web-search": "Web Search",
};

/** Capability → ModelRoleName. Capabilities are the user-facing
 * "what does this do" vocabulary; roles are the sidecar-internal
 * "which model slot" name. They differ because reranking maps to a
 * model called "reranker" and vision maps to "captioner". For
 * advanced-ocr the underlying ModelManager exposes 13 ``advanced-ocr-*``
 * sub-roles; the Settings UI groups them under the "advanced-ocr-"
 * prefix so a single capability cell shows aggregate progress. */
const CAPABILITY_TO_ROLE: Record<Capability, string> = {
  embedding: "embedding",
  reranking: "reranker",
  vision: "captioner",
  ocr: "ocr",
  "advanced-ocr": "advanced-ocr",
  chat: "chat",
  "web-search": "web-search",
};

type FilterId =
  | "all"
  | "configured"
  | "local"
  | "cloud"
  | Capability;

type Filter = {
  id: FilterId;
  label: string;
  /** When set, the chip shows a count badge. */
  count?: number;
};

/**
 * Always-visible Providers section. Lists every preset (configured
 * or not) with an Add/Details affordance. For local providers the row
 * also surfaces the underlying model role state (downloaded / pending
 * license / error) plus the action that unblocks it — replacing the
 * old "Show Diagnostics" toggle's separate Models card.
 */
export function ProvidersSection({
  settings,
  client,
  onSettingsChange,
  models,
  progress,
}: {
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
  models: SidecarEnvelope<ModelsStatus> | null;
  progress: ProgressByRole;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<FilterId>("all");

  // Probe key presence for cloud providers so the row's "configured"
  // indicator reflects the OS keychain truth, not just whether
  // settings.json has the provider entry.
  //
  // Once on mount only. The previous version re-probed on every
  // ``settings.providers`` reference change and on every ``openId``
  // toggle, which fired ~4 keychain reads each time the user just
  // *opened* Settings — and after a binary rebuild every read shows
  // a macOS Security Agent prompt because the ACL trust resets. Now
  // we track per-provider presence locally and update optimistically
  // from the editor's save/remove callbacks (see ``handleEditorClose``).
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
  }, [client]);

  const rolesByName: Record<string, ModelRoleStatus> = useMemo(() => {
    if (!models || models.state !== "ready" || !models.data) return {};
    return models.data.roles;
  }, [models]);

  const configuredCount = useMemo(
    () =>
      PROVIDER_PRESETS.filter((p) =>
        isProviderConfigured(p, settings, keyPresence, rolesByName)
      ).length,
    [settings, keyPresence, rolesByName]
  );

  const filters: Filter[] = useMemo(
    () => [
      { id: "all", label: "All", count: PROVIDER_PRESETS.length },
      { id: "configured", label: "Configured", count: configuredCount },
      {
        id: "local",
        label: "Local",
        count: PROVIDER_PRESETS.filter((p) => p.providerType === "local").length,
      },
      {
        id: "cloud",
        label: "Cloud",
        count: PROVIDER_PRESETS.filter((p) => p.providerType === "cloud").length,
      },
      { id: "embedding", label: "Embedding" },
      { id: "reranking", label: "Reranking" },
      { id: "vision", label: "Vision" },
      { id: "ocr", label: "OCR" },
    ],
    [configuredCount]
  );

  const visiblePresets = useMemo(() => {
    if (filter === "all") return PROVIDER_PRESETS;
    if (filter === "configured")
      return PROVIDER_PRESETS.filter((p) =>
        isProviderConfigured(p, settings, keyPresence, rolesByName)
      );
    if (filter === "local")
      return PROVIDER_PRESETS.filter((p) => p.providerType === "local");
    if (filter === "cloud")
      return PROVIDER_PRESETS.filter((p) => p.providerType === "cloud");
    return PROVIDER_PRESETS.filter((p) =>
      p.capabilities.includes(filter as Capability)
    );
  }, [filter, settings, keyPresence, rolesByName]);

  const featureProviderIds = useMemo(
    () =>
      new Set(
        Object.values(settings.features)
          .map((f) => f.providerId)
          .filter((id): id is string => Boolean(id))
      ),
    [settings.features]
  );

  return (
    <div className="settings-card providers-card">
      <div className="providers-card-header">
        <h2 className="settings-card-title providers-card-title">
          Providers
          <span className="providers-card-count">
            {configuredCount} of {PROVIDER_PRESETS.length} ready
          </span>
        </h2>
      </div>

      <div className="provider-filter-chips" role="tablist" aria-label="Filter providers">
        {filters.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            type="button"
            className={`provider-chip${filter === f.id ? " is-active" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.count != null ? (
              <span className="provider-chip-count">{f.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      <ul className="providers-list">
        {visiblePresets.map((preset) => {
          // ``role`` is the row's progress representative — for a
          // multi-stage provider (PP-StructureV3) we pick the
          // currently-downloading stage so the row's progress bar
          // reflects "what's happening now"; otherwise the first
          // not-ready stage; otherwise the first stage. Aggregate
          // progress lives in the sidebar DownloadDock.
          const ownedRoles = primaryRoleFor(preset, rolesByName);
          const role = pickRepresentativeRole(ownedRoles);
          return (
            <ProviderRow
              key={preset.providerId}
              preset={preset}
              role={role}
              ownedRoles={ownedRoles}
              progressByRole={progress}
              client={client}
              isConfigured={isProviderConfigured(
                preset,
                settings,
                keyPresence,
                rolesByName
              )}
              isInUse={featureProviderIds.has(preset.providerId)}
              isOpen={openId === preset.providerId}
              onToggle={() =>
                setOpenId(
                  openId === preset.providerId ? null : preset.providerId
                )
              }
            />
          );
        })}
        {visiblePresets.length === 0 ? (
          <li className="providers-empty">No providers match this filter.</li>
        ) : null}
      </ul>
      {openId
        ? (() => {
            const preset = PROVIDER_PRESETS.find(
              (p) => p.providerId === openId
            );
            if (!preset) return null;
            // Download-only local providers open the stages modal.
            // Configurable locals such as Ollama route through the
            // editor so users can change endpoint/model settings.
            if (preset.providerType === "local" && !usesProviderEditor(preset)) {
              const owned = Object.values(rolesByName).filter((role) =>
                presetOwnsRole(preset, role.role)
              );
              return (
                <ProviderStagesModal
                  preset={preset}
                  ownedRoles={owned}
                  progressByRole={progress}
                  client={client}
                  onClose={() => setOpenId(null)}
                />
              );
            }
            return (
              <ProviderEditorModal
                preset={preset}
                config={settings.providers[openId] ?? null}
                settings={settings}
                client={client}
                onSettingsChange={onSettingsChange}
                onClose={() => setOpenId(null)}
                onKeyPresenceChange={(providerId, present) =>
                  setKeyPresence((prev) => ({ ...prev, [providerId]: present }))
                }
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
  keyPresence: Record<string, boolean>,
  rolesByName: Record<string, ModelRoleStatus>
): boolean {
  if (preset.providerType === "local") {
    if (usesProviderEditor(preset)) {
      return settings.providers[preset.providerId]?.enabled === true;
    }
    // For locals "configured" means every underlying model role is
    // ready. ``primaryRoleFor`` returns the full set so a multi-
    // stage provider (PP-StructureV3 owns 13 ``advanced-ocr-*``
    // roles) reports configured only when ALL stages are ready —
    // otherwise the row would lie about being usable while the
    // bundle is still mid-download.
    //
    // If the preset declares no downloadable roles (rapidocr ships
    // bundled in the wheel) ``primaryRoleFor`` returns an empty
    // list, which we treat as configured — there's nothing to wait
    // for. Same fallback applies during the initial load before
    // the models envelope arrives.
    const roles = primaryRoleFor(preset, rolesByName);
    if (roles.length === 0) return true;
    return roles.every((role) => role.state === "ready");
  }
  if (preset.authKind === "api-key") {
    return keyPresence[preset.providerId] ?? false;
  }
  return settings.providers[preset.providerId] !== undefined;
}

function usesProviderEditor(preset: ProviderPreset): boolean {
  return preset.providerType === "cloud" || Boolean(preset.baseUrl);
}

function primaryRoleFor(
  preset: ProviderPreset,
  rolesByName: Record<string, ModelRoleStatus>
): ModelRoleStatus[] {
  if (preset.providerType !== "local" || !preset.localRoleId) return [];
  // Match by ownership rather than by the capability→role table
  // that hardcodes singular role names — multi-stage providers
  // (PP-StructureV3) own a *set* of role ids that share a prefix.
  return Object.values(rolesByName).filter((role) =>
    presetOwnsRole(preset, role.role)
  );
}

/** Pick a single role to feed into the row's progress UI. Returns
 * the first role currently downloading; else the first not-ready
 * role; else the first role (which will be ready). ``undefined``
 * when the provider has no downloadable roles. */
function pickRepresentativeRole(
  roles: ModelRoleStatus[]
): ModelRoleStatus | undefined {
  if (roles.length === 0) return undefined;
  return (
    roles.find((r) => r.state === "downloading") ??
    roles.find((r) => r.state !== "ready") ??
    roles[0]
  );
}

/** Strip the redundant "Local " prefix when we render the provider
 * name in the providers list — the runtime ("Local" / "Cloud") is
 * already shown next to it via :func:`ProviderRow`'s meta row. The
 * underlying ``displayName`` stays intact for places where the
 * runtime is not adjacent (e.g. the FeatureRow provider <select>). */
function rowDisplayName(preset: ProviderPreset): string {
  return preset.displayName.replace(/^Local\s+/, "");
}

function avatarText(preset: ProviderPreset): string {
  const parts = rowDisplayName(preset).split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ProviderRow({
  preset,
  role,
  ownedRoles,
  progressByRole,
  client,
  isConfigured,
  isInUse,
  isOpen,
  onToggle,
}: {
  preset: ProviderPreset;
  role: ModelRoleStatus | undefined;
  ownedRoles: ModelRoleStatus[];
  progressByRole: ProgressByRole;
  client: SearchClient;
  isConfigured: boolean;
  isInUse: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const RuntimeIcon = preset.providerType === "local" ? Cpu : Cloud;
  const capLabel = preset.capabilities
    .map((c) => CAPABILITY_LABEL[c])
    .join(", ");

  const status = derivePresetStatus(preset, role, isConfigured);

  return (
    <li className={`provider-row provider-card${isInUse ? " is-in-use" : ""}${isOpen ? " is-open" : ""}`}>
      <div className={`provider-avatar provider-avatar--${preset.providerType}`}>
        {avatarText(preset)}
      </div>
      <div className="provider-row-meta provider-card-info">
        <div className="provider-row-name provider-card-name">
          {rowDisplayName(preset)}
          {isInUse ? (
            <span className="provider-card-using">In use</span>
          ) : null}
        </div>
        <div className="provider-row-type provider-card-meta">
          <span className="provider-card-runtime">
            <RuntimeIcon size={11} aria-hidden="true" />
            {preset.providerType === "local" ? "Local" : "Cloud"}
          </span>
          <span className="provider-card-meta-sep">·</span>
          <span>{capLabel}</span>
          {/* Repo badge moved into the per-stage list inside
           * ProviderStagesModal — keeps the row meta scannable
           * (especially for multi-stage providers where one badge
           * doesn't represent the whole bundle). */}
        </div>
        {role?.error ? (
          <p className="provider-card-error" title={role.error}>
            {truncate(role.error, 96)}
          </p>
        ) : null}
        {/* Live download progress lives on the action button itself
         * (right column) — no separate bar here, otherwise the row
         * shows the same percent twice. */}
      </div>
      <div className="provider-row-actions provider-card-actions">
        <span
          className={`provider-status-pill provider-row-status ${status.toneClass}${status.toneClass === "is-configured" ? " is-ok" : ""}`}
        >
          <span className="provider-status-dot" aria-hidden="true" />
          {status.label}
        </span>
        <ProviderActions
          preset={preset}
          role={role}
          progress={role ? progressByRole[role.role] : undefined}
          client={client}
          isConfigured={isConfigured}
          isOpen={isOpen}
          onToggle={onToggle}
        />
      </div>
    </li>
  );
}

type DerivedStatus = { label: string; toneClass: string };

function derivePresetStatus(
  preset: ProviderPreset,
  role: ModelRoleStatus | undefined,
  isConfigured: boolean
): DerivedStatus {
  if (preset.providerType === "local" && role) {
    if (role.state === "ready") return { label: "Ready", toneClass: "is-configured" };
    if (role.state === "downloading")
      return { label: "Downloading", toneClass: "is-pending" };
    if (role.state === "verifying")
      return { label: "Verifying", toneClass: "is-pending" };
    if (role.state === "missing") {
      return { label: "Not downloaded", toneClass: "is-empty" };
    }
    if (role.state === "error")
      return { label: "Error", toneClass: "is-error" };
  }
  return isConfigured
    ? { label: "Ready", toneClass: "is-configured" }
    : { label: "Not set up", toneClass: "is-empty" };
}

function ProviderActions({
  preset,
  role,
  progress,
  client,
  isConfigured,
  isOpen,
  onToggle,
}: {
  preset: ProviderPreset;
  role: ModelRoleStatus | undefined;
  progress: ModelDownloadEvent | undefined;
  client: SearchClient;
  isConfigured: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const [busy, setBusy] = useState<"download" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const liveState = progress?.state;
  const isLiveDownloading =
    liveState === "downloading" || liveState === "verifying";

  // Local providers route through model-role actions; cloud
  // providers stay on the simple Edit/Add affordance.
  if (preset.providerType === "local" && role) {
    // Capture the narrowed value so the closures below don't have
    // to re-check `role` for nullability.
    const localRole: ModelRoleStatus = role;
    const canDownload =
      localRole.state === "missing" && !isLiveDownloading;
    const canRetry = localRole.state === "error" && !isLiveDownloading;

    async function handleDownload() {
      setBusy("download");
      setActionError(null);
      try {
        await client.startModelDownload({ role: localRole.role });
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : "Download failed to start."
        );
      } finally {
        setBusy(null);
      }
    }

    const pct = progressPercent(progress);
    return (
      <>
        {isLiveDownloading ? (
          <button
            type="button"
            className="settings-action is-progress"
            disabled
            aria-label={`Downloading ${preset.displayName}: ${pct}%`}
          >
            <span
              aria-hidden="true"
              className="settings-action-progress-fill"
              style={{ width: `${pct}%` }}
            />
            <span className="settings-action-progress-label">
              {liveState === "verifying" ? "Verifying…" : `${pct}%`}
            </span>
          </button>
        ) : canDownload ? (
          <button
            type="button"
            className="settings-action is-primary"
            disabled={busy !== null}
            onClick={() => void handleDownload()}
          >
            {busy === "download" ? "Starting…" : "Download"}
          </button>
        ) : canRetry ? (
          <button
            type="button"
            className="settings-action"
            disabled={busy !== null}
            onClick={() => void handleDownload()}
          >
            Retry
          </button>
        ) : (
          <button
            type="button"
            className="settings-action"
            onClick={onToggle}
            aria-expanded={isOpen}
          >
            {isOpen ? "Close" : "Details"}
          </button>
        )}
        {actionError ? (
          <span className="provider-card-error" role="status">
            {actionError}
          </span>
        ) : null}
      </>
    );
  }

  // Cloud providers (or local with no role data yet).
  return (
    <button
      type="button"
      className={`settings-action${!isConfigured ? " is-primary" : ""}`}
      onClick={onToggle}
      aria-expanded={isOpen}
    >
      {isOpen ? "Close" : isConfigured ? "Details" : "Add"}
    </button>
  );
}

/** Percent for an in-progress download. Returns 0 when the
 * payload total is unknown (e.g., HF resolves Content-Length
 * lazily for large repos) — the action button still renders, just
 * without a meaningful fill until the next event. */
function progressPercent(progress: ModelDownloadEvent | undefined): number {
  if (!progress) return 0;
  const total = progress.bytesTotal ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((progress.bytesDownloaded / total) * 100));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}
