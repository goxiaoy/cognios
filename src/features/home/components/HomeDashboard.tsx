import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Boxes,
  Cpu,
  Database,
  Download,
  Gauge,
  Search,
  Zap,
} from "lucide-react";

import type {
  IndexStatus,
  LatencySummary,
  ModelDownloadEvent,
  ModelsStatus,
  SearchObservability,
  SearchSettings,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { PROVIDER_PRESETS } from "../../settings/data/providerPresets";
import { useModelDownloadProgress } from "../../settings/hooks/useModelDownloadProgress";
import { useSearchSubsystemStatus } from "../../settings/hooks/useSearchSubsystemStatus";

const POLL_INTERVAL_MS = 5_000;

export function HomeDashboard({ client }: { client: SearchClient }) {
  const { models, indexing } = useSearchSubsystemStatus(client);
  const progress = useModelDownloadProgress();
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [observability, setObservability] =
    useState<SidecarEnvelope<SearchObservability> | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      try {
        const env = await client.settings();
        if (cancelled) return;
        if (env.state === "ready" && env.data) {
          setSettings(env.data);
          setSettingsError(null);
          return;
        }
        if (env.state === "unavailable") {
          setSettingsError(env.error ?? "Settings unavailable.");
        }
      } catch (err) {
        if (!cancelled) {
          setSettingsError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const env = await client.observability();
        if (!cancelled) setObservability(env);
      } catch {
        if (!cancelled) {
          setObservability({
            state: "unavailable",
            error: "Observability unavailable.",
          });
        }
      }
      if (!cancelled) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  const indexData = readyData(indexing);
  const modelData = readyData(models);
  const observabilityData = readyData(observability);
  const configuredProviders = settings ? countConfigured(settings) : null;
  const totalProviders = PROVIDER_PRESETS.length;
  const modelCounts = modelReadiness(modelData);
  const enhancement = enhancementDisplay(indexData, modelData);
  const activeDownloads = useMemo(
    () =>
      Object.values(progress).filter((event) =>
        ["queued", "downloading", "verifying"].includes(String(event.state))
      ),
    [progress]
  );

  return (
    <section className="home-dashboard" aria-label="Home statistics">
      <section className="home-kpi-grid" aria-label="Current status">
        <StatTile
          icon={<Database size={17} aria-hidden="true" />}
          label="Indexed items"
          value={indexData ? indexData.indexedChunks.toLocaleString() : "—"}
          sub={indexData ? `${indexData.queueDepth} queued` : statusCopy(indexing)}
        />
        <StatTile
          icon={<Activity size={17} aria-hidden="true" />}
          label="In flight"
          value={indexData ? activeIndexJobs(indexData).toLocaleString() : "—"}
          sub="jobs running"
        />
        <StatTile
          icon={<Boxes size={17} aria-hidden="true" />}
          label="OCR enhancement"
          value={enhancement.value}
          sub={enhancement.sub}
          tone={enhancement.tone}
        />
        <StatTile
          icon={<Cpu size={17} aria-hidden="true" />}
          label="Model roles"
          value={
            modelCounts.total === null
              ? "—"
              : `${modelCounts.ready} / ${modelCounts.total}`
          }
          sub={modelCounts.total === null ? statusCopy(models) : "ready"}
        />
        <StatTile
          icon={<Zap size={17} aria-hidden="true" />}
          label="Engines"
          value={
            configuredProviders === null
              ? "—"
              : `${configuredProviders} / ${totalProviders}`
          }
          sub={settingsError ?? "configured"}
        />
      </section>

      <div className="home-main-grid">
        <section className="home-section home-activity">
          <header className="home-section-head">
            <h2>Recent indexing</h2>
            <span>{sumIndexed(observabilityData).toLocaleString()} nodes</span>
          </header>
          <ActivityHeatmap days={observabilityData?.recentIndexedNodes ?? []} />
        </section>

        <section className="home-section">
          <header className="home-section-head">
            <h2>Latency</h2>
            <span>{observabilityData ? "recent samples" : statusCopy(observability)}</span>
          </header>
          <LatencyRows observability={observabilityData} />
        </section>

        <section className="home-section">
          <header className="home-section-head">
            <h2>Token usage</h2>
            <span>{tokenTotal(observabilityData).toLocaleString()} tokens</span>
          </header>
          <TokenUsage observability={observabilityData} />
        </section>

        <section className="home-section">
          <header className="home-section-head">
            <h2>Downloads</h2>
            <span>{activeDownloads.length} active</span>
          </header>
          <DownloadRows downloads={activeDownloads} />
        </section>
      </div>
    </section>
  );
}

function StatTile({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  return (
    <article className={`home-stat is-${tone}`}>
      <div className="home-stat-icon">{icon}</div>
      <div>
        <p className="home-stat-label">{label}</p>
        <p className="home-stat-value">{value}</p>
        <p className="home-stat-sub">{sub}</p>
      </div>
    </article>
  );
}

function ActivityHeatmap({ days }: { days: SearchObservability["recentIndexedNodes"] }) {
  if (days.length === 0) {
    return <p className="home-empty">No recent indexed nodes.</p>;
  }
  const max = Math.max(...days.map((day) => day.count), 1);
  return (
    <div className="home-heatmap" aria-label="Recent indexed nodes by day">
      {days.map((day) => (
        <span
          key={day.date}
          className={`home-heat-cell is-level-${heatLevel(day.count, max)}`}
          title={`${day.date}: ${day.count} indexed`}
          aria-label={`${day.date}: ${day.count} indexed`}
        />
      ))}
    </div>
  );
}

function LatencyRows({
  observability,
}: {
  observability: SearchObservability | null;
}) {
  const rows: Array<[string, LatencySummary, ReactNode]> | null =
    observability
      ? [
          ["Search", observability.latency.search, <Search size={14} aria-hidden="true" />],
          ["Index", observability.latency.indexing, <Gauge size={14} aria-hidden="true" />],
          ["OCR", observability.latency.enhancement, <Activity size={14} aria-hidden="true" />],
          ["Model download", observability.latency.modelDownload, <Download size={14} aria-hidden="true" />],
        ]
      : null;
  if (!rows) return <p className="home-empty">Latency unavailable.</p>;
  return (
    <div className="home-latency-list">
      {rows.map(([label, summary, icon]) => (
        <div className="home-latency-row" key={label}>
          <span className="home-row-label">
            {icon}
            {label}
          </span>
          <span>P50 {formatMs(summary.p50Ms)}</span>
          <span>P90 {formatMs(summary.p90Ms)}</span>
          <span>P99 {formatMs(summary.p99Ms)}</span>
          <span>{summary.sampleCount} samples</span>
        </div>
      ))}
    </div>
  );
}

function TokenUsage({
  observability,
}: {
  observability: SearchObservability | null;
}) {
  const usage = observability?.tokenUsage ?? [];
  if (usage.length === 0) {
    return <p className="home-empty">No token usage reported.</p>;
  }
  return (
    <div className="home-token-list">
      {usage.slice(0, 5).map((row) => (
        <div className="home-token-row" key={`${row.providerId}:${row.model}`}>
          <div>
            <p className="home-token-model">{row.model}</p>
            <p className="home-token-provider">{row.providerId}</p>
          </div>
          <div className="home-token-total">
            {row.totalTokens.toLocaleString()}
            <span>tokens</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DownloadRows({
  downloads,
}: {
  downloads: ModelDownloadEvent[];
}) {
  if (downloads.length === 0) {
    return <p className="home-empty">No active downloads.</p>;
  }
  return (
    <div className="home-download-list">
      {downloads.map((event) => {
        const percent =
          event.bytesTotal && event.bytesTotal > 0
            ? Math.round((event.bytesDownloaded / event.bytesTotal) * 100)
            : 0;
        return (
          <div className="home-download-row" key={event.role}>
            <div className="home-download-meta">
              <span>{event.role}</span>
              <span>{String(event.state)}</span>
            </div>
            <div className="home-progress">
              <i style={{ width: `${Math.max(0, Math.min(percent, 100))}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function readyData<T>(env: SidecarEnvelope<T> | null): T | null {
  return env?.state === "ready" && env.data ? env.data : null;
}

function statusCopy<T>(env: SidecarEnvelope<T> | null): string {
  if (!env) return "loading";
  if (env.state === "initialising") return "starting";
  if (env.state === "unavailable") return env.error ?? "unavailable";
  return "loading";
}

function countConfigured(settings: SearchSettings): number {
  return PROVIDER_PRESETS.reduce((count, preset) => {
    if (preset.authKind === "none") return count + 1;
    return settings.providers[preset.providerId] !== undefined ? count + 1 : count;
  }, 0);
}

function modelReadiness(models: ModelsStatus | null): {
  ready: number;
  total: number | null;
} {
  if (!models) return { ready: 0, total: null };
  const roles = Object.values(models.roles);
  return {
    ready: roles.filter((role) => role.state === "ready").length,
    total: roles.length,
  };
}

function activeIndexJobs(indexing: IndexStatus): number {
  return indexing.inFlight.length + indexing.enhancementInFlight.length;
}

function enhancementDisplay(
  indexing: IndexStatus | null,
  models: ModelsStatus | null
): { value: string; sub: string; tone: "neutral" | "ok" | "warn" } {
  const hasAdvancedOcrReady = models
    ? Object.values(models.roles).some(
        (role) => role.role.startsWith("advanced-ocr-") && role.state === "ready"
      )
    : false;
  if (!hasAdvancedOcrReady) return { value: "—", sub: "not active", tone: "neutral" };
  if (!indexing) return { value: "—", sub: "loading", tone: "neutral" };
  if (indexing.enhancementTotalImages === 0) {
    return { value: "0", sub: "eligible images", tone: "neutral" };
  }
  const total = indexing.enhancementTotalImages;
  const failed = indexing.enhancementFailed;
  const completed = Math.max(total - indexing.enhancementPending - failed, 0);
  if (failed > 0) {
    return {
      value: `${completed} / ${total}`,
      sub: `${failed} failed`,
      tone: "warn",
    };
  }
  return {
    value: `${completed} / ${total}`,
    sub: indexing.enhancementPending > 0 ? `${indexing.enhancementPending} pending` : "complete",
    tone: indexing.enhancementPending > 0 ? "neutral" : "ok",
  };
}

function heatLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / max) * 4)));
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function sumIndexed(observability: SearchObservability | null): number {
  return (observability?.recentIndexedNodes ?? []).reduce(
    (sum, day) => sum + day.count,
    0
  );
}

function tokenTotal(observability: SearchObservability | null): number {
  return (observability?.tokenUsage ?? []).reduce(
    (sum, row) => sum + row.totalTokens,
    0
  );
}
