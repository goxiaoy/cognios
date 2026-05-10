import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Boxes,
  Database,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  IndexStatus,
  LatencyTrendPoint,
  ModelsStatus,
  SearchObservability,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { useSearchSubsystemStatus } from "../../settings/hooks/useSearchSubsystemStatus";

const POLL_INTERVAL_MS = 5_000;
const RECENT_INDEX_WINDOWS = [7, 30, 90] as const;
type RecentIndexWindow = (typeof RECENT_INDEX_WINDOWS)[number];
const LATENCY_METRICS = [
  { key: "p99Ms", label: "P99" },
  { key: "p90Ms", label: "P90" },
  { key: "p50Ms", label: "P50" },
] as const;
type LatencyMetricKey = (typeof LATENCY_METRICS)[number]["key"];
const LATENCY_CATEGORIES = [
  { key: "search", label: "Search", color: "#16794f" },
  { key: "indexing", label: "Index", color: "#3867b7" },
  { key: "enhancement", label: "OCR", color: "#9a5a00" },
] as const;
type LatencyCategoryKey = (typeof LATENCY_CATEGORIES)[number]["key"];
const CHART_ACCENT = "var(--accent)";
const CHART_MUTED = "var(--muted)";
const CHART_LINE = "var(--line)";

export function HomeDashboard({ client }: { client: SearchClient }) {
  const { models, indexing } = useSearchSubsystemStatus(client);
  const [observability, setObservability] =
    useState<SidecarEnvelope<SearchObservability> | null>(null);
  const [recentIndexDays, setRecentIndexDays] =
    useState<RecentIndexWindow>(30);
  const [latencyMetric, setLatencyMetric] =
    useState<LatencyMetricKey>("p99Ms");
  const [latencyCategory, setLatencyCategory] =
    useState<LatencyCategoryKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const env = await client.observability({ recentDays: recentIndexDays });
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
  }, [client, recentIndexDays]);

  const indexData = readyData(indexing);
  const modelData = readyData(models);
  const observabilityData = readyData(observability);
  const enhancement = enhancementDisplay(indexData, modelData);

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
      </section>

      <div className="home-main-grid">
        <section className="home-section home-activity">
          <header className="home-section-head home-section-head--with-control">
            <div>
              <h2>Recent indexing</h2>
              <span>{sumIndexed(observabilityData).toLocaleString()} nodes</span>
            </div>
            <div
              className="home-window-toggle"
              role="group"
              aria-label="Recent indexing range"
            >
              {RECENT_INDEX_WINDOWS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className="home-window-toggle-button"
                  aria-pressed={recentIndexDays === days}
                  onClick={() => setRecentIndexDays(days)}
                >
                  {days}d
                </button>
              ))}
            </div>
          </header>
          <ActivityChart
            days={observabilityData?.recentIndexedNodes ?? []}
            windowDays={recentIndexDays}
          />
        </section>

        <section className="home-section">
          <header className="home-section-head home-section-head--with-control">
            <div>
              <h2>Latency</h2>
              <span>{observabilityData ? "recent samples" : statusCopy(observability)}</span>
            </div>
            <div
              className="home-window-toggle"
              role="group"
              aria-label="Latency percentile"
            >
              {LATENCY_METRICS.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  className="home-window-toggle-button"
                  aria-pressed={latencyMetric === metric.key}
                  onClick={() => setLatencyMetric(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </div>
          </header>
          <LatencyChart
            observability={observabilityData}
            metric={latencyMetric}
            category={latencyCategory}
            onCategoryChange={(category) =>
              setLatencyCategory((current) => (current === category ? null : category))
            }
          />
        </section>

        <section className="home-section">
          <header className="home-section-head">
            <h2>Token usage</h2>
            <span>{tokenTotal(observabilityData).toLocaleString()} tokens</span>
          </header>
          <TokenUsage observability={observabilityData} />
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

function ActivityChart({
  days,
  windowDays,
}: {
  days: SearchObservability["recentIndexedNodes"];
  windowDays: RecentIndexWindow;
}) {
  if (days.length === 0) {
    return <p className="home-empty">No recent indexed nodes.</p>;
  }
  if (windowDays === 90) {
    return <ActivityHeatmap days={days} />;
  }
  const data = days.map((day) => ({
    date: day.date,
    label: compactDate(day.date),
    count: day.count,
  }));
  return (
    <div className="home-chart" role="img" aria-label="Recent indexed nodes bar chart">
      <ResponsiveContainer width="100%" height={150}>
        <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={CHART_LINE} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_MUTED, fontSize: 10 }}
            interval={windowDays === 7 ? 0 : 4}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_MUTED, fontSize: 10 }}
            width={34}
          />
          <Tooltip
            cursor={{ fill: "rgba(22, 121, 79, 0.08)" }}
            contentStyle={tooltipStyle()}
            labelFormatter={(_label, payload) => payload?.[0]?.payload?.date ?? ""}
            formatter={(value) => [`${Number(value).toLocaleString()} nodes`, "Indexed"]}
          />
          <Bar dataKey="count" fill={CHART_ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ActivityHeatmap({ days }: { days: SearchObservability["recentIndexedNodes"] }) {
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

function LatencyChart({
  observability,
  metric,
  category,
  onCategoryChange,
}: {
  observability: SearchObservability | null;
  metric: LatencyMetricKey;
  category: LatencyCategoryKey | null;
  onCategoryChange: (category: LatencyCategoryKey) => void;
}) {
  if (!observability) return <p className="home-empty">Latency unavailable.</p>;
  const data = latencyChartData(observability, metric);
  const visibleCategories = category
    ? LATENCY_CATEGORIES.filter((item) => item.key === category)
    : LATENCY_CATEGORIES;
  const hasTrend = data.some((point) =>
    visibleCategories.some((item) => typeof point[item.key] === "number")
  );
  return (
    <div className="home-latency-panel">
      {hasTrend ? (
        <div className="home-chart" role="img" aria-label={`${metricLabel(metric)} latency line chart`}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke={CHART_LINE} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: CHART_MUTED, fontSize: 10 }}
                minTickGap={18}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: CHART_MUTED, fontSize: 10 }}
                tickFormatter={(value) => formatMs(Number(value))}
                width={42}
              />
              <Tooltip
                contentStyle={tooltipStyle()}
                formatter={(value, name) => [formatMs(Number(value)), latencySeriesLabel(String(name))]}
              />
              {visibleCategories.map((item) => (
                <Line
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  stroke={item.color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="home-empty">No latency trend samples.</p>
      )}
      <div className="home-latency-legend" aria-label={`${metricLabel(metric)} latency values`}>
        {latencySummaries(observability, metric).map((row) => (
          <button
            key={row.key}
            type="button"
            className="home-latency-legend-button"
            aria-pressed={category === row.key}
            onClick={() => onCategoryChange(row.key)}
          >
            <i style={{ background: row.color }} />
            {row.label} {formatMs(row.value)}
          </button>
        ))}
      </div>
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
  const rows = usage.slice(0, 6).map((row) => ({
    name: row.model,
    provider: row.providerId,
    totalTokens: row.totalTokens,
    label: `${row.model} · ${row.providerId}`,
  }));
  const height = Math.max(150, rows.length * 34 + 32);
  return (
    <div className="home-chart" role="img" aria-label="Token usage bar chart">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 18, bottom: 0, left: 8 }}
        >
          <CartesianGrid stroke={CHART_LINE} strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_MUTED, fontSize: 10 }}
            tickFormatter={(value) => compactNumber(Number(value))}
          />
          <YAxis
            type="category"
            dataKey="name"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_MUTED, fontSize: 10 }}
            width={82}
          />
          <Tooltip
            contentStyle={tooltipStyle()}
            labelFormatter={(_label, payload) => payload?.[0]?.payload?.label ?? ""}
            formatter={(value) => [`${Number(value).toLocaleString()} tokens`, "Usage"]}
          />
          <Bar dataKey="totalTokens" fill={CHART_ACCENT} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function latencyChartData(
  observability: SearchObservability,
  metric: LatencyMetricKey
) {
  const buckets = new Map<string, Record<string, string | number | null>>();
  const add = (
    series: LatencyTrendPoint[],
    key: LatencyCategoryKey
  ) => {
    for (const point of series) {
      const current =
        buckets.get(point.bucket) ?? {
          bucket: point.bucket,
          label: compactDate(point.bucket),
        };
      current[key] = point[metric] ?? null;
      buckets.set(point.bucket, current);
    }
  };
  add(observability.latencyTrends?.search ?? [], "search");
  add(observability.latencyTrends?.indexing ?? [], "indexing");
  add(observability.latencyTrends?.enhancement ?? [], "enhancement");
  return Array.from(buckets.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket))
  );
}

function latencySummaries(
  observability: SearchObservability,
  metric: LatencyMetricKey
) {
  return LATENCY_CATEGORIES.map((category) => ({
    ...category,
    value: observability.latency[category.key][metric],
  }));
}

function latencySeriesLabel(key: string): string {
  if (key === "indexing") return "Index";
  if (key === "enhancement") return "OCR";
  return "Search";
}

function metricLabel(metric: LatencyMetricKey): string {
  return LATENCY_METRICS.find((item) => item.key === metric)?.label ?? "Latency";
}

function compactDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : value;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function tooltipStyle() {
  return {
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-sm)",
    background: "var(--paper)",
    color: "var(--ink)",
    fontSize: "0.75rem",
  };
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
