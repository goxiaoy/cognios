import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Activity,
  Boxes,
  Database,
  FileSearch,
  FileText,
  FolderOpen,
  MessageCircle,
  Mic2,
  X,
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
  SearchSettings,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import {
  CHAT_PROVIDER_PRESETS,
  ChatProviderSetup,
  DEFAULT_CHAT_PROVIDER_ID,
} from "../../chat/components/ChatProviderSetup";
import type { ExplorerNode } from "../../explorer/types/explorer";
import type { SearchClient } from "../../search/types/search";
import { FeatureRow } from "../../settings/components/FeatureRow";
import { FEATURE_CATALOG } from "../../settings/data/providerPresets";
import { useSearchSubsystemStatus } from "../../settings/hooks/useSearchSubsystemStatus";
import {
  advancedOcrPromptFingerprint,
  chatPromptFingerprint,
  isWorkspaceEmpty,
  shouldPromptForAdvancedOcr,
  shouldPromptForChatProvider,
} from "../utils/onboardingSignals";

const POLL_INTERVAL_MS = 5_000;
const METRICS_WINDOW_DAYS = 30;
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
const TOKEN_SERIES_COLORS = [
  "#16794f",
  "#3867b7",
  "#9a5a00",
  "#7c3aed",
  "#be123c",
  "#0f766e",
];
const CHART_ACCENT = "var(--accent)";
const CHART_MUTED = "var(--muted)";
const CHART_LINE = "var(--line)";
const ADVANCED_OCR_META = FEATURE_CATALOG.find(
  (meta) => meta.featureId === "advanced-ocr"
);

interface HomeDashboardProps {
  client: SearchClient;
  workspaceNodes?: ExplorerNode[];
  onCreateNote?(): void;
  onMountFolder?(): void;
  onStartVoiceNote?(): void;
}

export function HomeDashboard({
  client,
  workspaceNodes,
  onCreateNote,
  onMountFolder,
  onStartVoiceNote,
}: HomeDashboardProps) {
  const { models, indexing } = useSearchSubsystemStatus(client);
  const [recentObservability, setRecentObservability] =
    useState<SidecarEnvelope<SearchObservability> | null>(null);
  const [metricsObservability, setMetricsObservability] =
    useState<SidecarEnvelope<SearchObservability> | null>(null);
  const [recentIndexDays, setRecentIndexDays] =
    useState<RecentIndexWindow>(30);
  const [latencyMetric, setLatencyMetric] =
    useState<LatencyMetricKey>("p99Ms");
  const [latencyCategory, setLatencyCategory] =
    useState<LatencyCategoryKey | null>(null);
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [dismissedPromptFingerprints, setDismissedPromptFingerprints] =
    useState<Record<string, string>>({});
  const [chatSetupOpen, setChatSetupOpen] = useState(false);
  const [advancedOcrSetupOpen, setAdvancedOcrSetupOpen] = useState(false);
  const [selectedChatProviderId, setSelectedChatProviderId] = useState(
    DEFAULT_CHAT_PROVIDER_ID
  );
  const workspaceIsEmpty = workspaceNodes
    ? isWorkspaceEmpty(workspaceNodes)
    : false;

  const refreshSettings = useCallback(async () => {
    if (!workspaceNodes || workspaceIsEmpty) {
      setSettings(null);
      return;
    }

    try {
      const env = await client.settings();
      if (env.state === "ready" && env.data) {
        setSettings(env.data);
      } else {
        setSettings(null);
      }
    } catch {
      setSettings(null);
    }
  }, [client, workspaceIsEmpty, workspaceNodes]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        if (recentIndexDays === METRICS_WINDOW_DAYS) {
          const env = await client.observability({ recentDays: METRICS_WINDOW_DAYS });
          if (!cancelled) {
            setRecentObservability(env);
            setMetricsObservability(env);
          }
        } else {
          const [recentEnv, metricsEnv] = await Promise.all([
            client.observability({ recentDays: recentIndexDays }),
            client.observability({ recentDays: METRICS_WINDOW_DAYS }),
          ]);
          if (!cancelled) {
            setRecentObservability(recentEnv);
            setMetricsObservability(metricsEnv);
          }
        }
      } catch {
        if (!cancelled) {
          const unavailable: SidecarEnvelope<SearchObservability> = {
            state: "unavailable",
            error: "Observability unavailable.",
          };
          setRecentObservability(unavailable);
          setMetricsObservability(unavailable);
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

  useEffect(() => {
    let cancelled = false;
    void refreshSettings().catch(() => {
      if (!cancelled) setSettings(null);
    });

    return () => {
      cancelled = true;
    };
  }, [refreshSettings]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "hidden") return;
      void refreshSettings();
    }

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshSettings]);

  useEffect(() => {
    const providerId = settings?.features.llm?.providerId;
    if (
      providerId &&
      CHAT_PROVIDER_PRESETS.some((preset) => preset.providerId === providerId)
    ) {
      setSelectedChatProviderId(providerId);
    }
  }, [settings]);

  const indexData = readyData(indexing);
  const modelData = readyData(models);
  const recentObservabilityData = readyData(recentObservability);
  const metricsObservabilityData = readyData(metricsObservability);
  const enhancement = enhancementDisplay(indexData, modelData);
  const indexLoading = isLoading(indexing);
  const enhancementLoading = isLoading(indexing) || isLoading(models);
  const recentLoading = isLoading(recentObservability);
  const metricsLoading = isLoading(metricsObservability);

  if (workspaceIsEmpty) {
    return (
      <section className="home-dashboard" aria-label="Home onboarding">
        <EmptyNodeLaunchpad
          onCreateNote={onCreateNote}
          onMountFolder={onMountFolder}
          onStartVoiceNote={onStartVoiceNote}
        />
      </section>
    );
  }

  return (
    <section className="home-dashboard" aria-label="Home statistics">
      {workspaceNodes ? (
        <HomeSecondaryPrompts
          dismissedPromptFingerprints={dismissedPromptFingerprints}
          nodes={workspaceNodes}
          onDismiss={(key, fingerprint) =>
            dismissPrompt(key, fingerprint, setDismissedPromptFingerprints)
          }
          onSetUpAdvancedOcr={() => setAdvancedOcrSetupOpen(true)}
          onSetUpChat={() => setChatSetupOpen(true)}
          settings={settings}
        />
      ) : null}

      <section className="home-kpi-grid" aria-label="Current status">
        <StatTile
          icon={<Database size={17} aria-hidden="true" />}
          label="Indexed items"
          value={indexData ? indexData.indexedChunks.toLocaleString() : "—"}
          sub={indexData ? `${indexData.queueDepth} queued` : statusCopy(indexing)}
          loading={indexLoading}
        />
        <StatTile
          icon={<Activity size={17} aria-hidden="true" />}
          label="In flight"
          value={indexData ? activeIndexJobs(indexData).toLocaleString() : "—"}
          sub="jobs running"
          loading={indexLoading}
        />
        <StatTile
          icon={<Boxes size={17} aria-hidden="true" />}
          label="OCR enhancement"
          value={enhancement.value}
          sub={enhancement.sub}
          tone={enhancement.tone}
          loading={enhancementLoading}
        />
      </section>

      <div className="home-main-grid">
        <section className="home-section home-activity">
          <header className="home-section-head home-section-head--with-control">
            <div>
              <h2>Recent indexing</h2>
              <span>{sumIndexed(recentObservabilityData).toLocaleString()} nodes</span>
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
            days={recentObservabilityData?.recentIndexedNodes ?? []}
            windowDays={recentIndexDays}
            loading={recentLoading}
          />
        </section>

        <section className="home-section">
          <header className="home-section-head home-section-head--with-control">
            <div>
              <h2>Latency</h2>
              <span>{metricsLoading ? "loading" : metricsObservabilityData ? "recent samples" : statusCopy(metricsObservability)}</span>
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
            observability={metricsObservabilityData}
            metric={latencyMetric}
            category={latencyCategory}
            loading={metricsLoading}
            onCategoryChange={(category) =>
              setLatencyCategory((current) => (current === category ? null : category))
            }
          />
        </section>

        <section className="home-section">
          <header className="home-section-head">
            <h2>Token usage</h2>
            <span>{metricsLoading ? "loading" : `${tokenTotal(metricsObservabilityData).toLocaleString()} tokens`}</span>
          </header>
          <TokenUsage observability={metricsObservabilityData} loading={metricsLoading} />
        </section>
      </div>

      {chatSetupOpen && settings ? (
        <HomeSetupModal title="Set up Chat" onClose={() => setChatSetupOpen(false)}>
          <ChatProviderSetup
            client={client}
            providerStatus={null}
            selectedProviderId={selectedChatProviderId}
            settings={settings}
            onSelectedProviderChange={setSelectedChatProviderId}
            onSettingsChange={setSettings}
          />
        </HomeSetupModal>
      ) : null}

      {advancedOcrSetupOpen && settings && ADVANCED_OCR_META ? (
        <HomeSetupModal
          title="Set up Advanced OCR"
          onClose={() => setAdvancedOcrSetupOpen(false)}
        >
          <ul className="home-feature-setup-list">
            <FeatureRow
              client={client}
              config={settings.features["advanced-ocr"]}
              meta={ADVANCED_OCR_META}
              settings={settings}
              onSettingsChange={setSettings}
            />
          </ul>
        </HomeSetupModal>
      ) : null}
    </section>
  );
}

function EmptyNodeLaunchpad({
  onCreateNote,
  onMountFolder,
  onStartVoiceNote,
}: {
  onCreateNote?(): void;
  onMountFolder?(): void;
  onStartVoiceNote?(): void;
}) {
  return (
    <section className="home-onboarding" aria-label="Create first content">
      <div className="home-onboarding-copy">
        <p className="home-onboarding-kicker">Start with local content</p>
        <h2>Build your first memory node</h2>
        <p>
          Add a folder, write a note, or capture a voice note. You can still
          use the rest of CogniOS while this workspace is empty.
        </p>
      </div>
      <div className="home-onboarding-actions" aria-label="First content actions">
        <button
          type="button"
          className="home-onboarding-action"
          onClick={onMountFolder}
        >
          <FolderOpen size={18} aria-hidden="true" />
          <span>
            <strong>Mount Folder</strong>
            <small>Link local files</small>
          </span>
        </button>
        <button
          type="button"
          className="home-onboarding-action"
          onClick={onCreateNote}
        >
          <FileText size={18} aria-hidden="true" />
          <span>
            <strong>Create Note</strong>
            <small>Write markdown locally</small>
          </span>
        </button>
        <button
          type="button"
          className="home-onboarding-action"
          onClick={onStartVoiceNote}
        >
          <Mic2 size={18} aria-hidden="true" />
          <span>
            <strong>Voice Note</strong>
            <small>Capture a meeting or thought</small>
          </span>
        </button>
      </div>
    </section>
  );
}

function HomeSecondaryPrompts({
  dismissedPromptFingerprints,
  nodes,
  onDismiss,
  onSetUpAdvancedOcr,
  onSetUpChat,
  settings,
}: {
  dismissedPromptFingerprints: Record<string, string>;
  nodes: ExplorerNode[];
  onDismiss(key: string, fingerprint: string): void;
  onSetUpAdvancedOcr(): void;
  onSetUpChat(): void;
  settings: SearchSettings | null;
}) {
  const chatFingerprint = chatPromptFingerprint(settings);
  const ocrFingerprint = advancedOcrPromptFingerprint(nodes, settings);
  const showChat =
    shouldPromptForChatProvider(settings) &&
    !isPromptDismissed("chat-provider", chatFingerprint, dismissedPromptFingerprints);
  const showAdvancedOcr =
    shouldPromptForAdvancedOcr(nodes, settings) &&
    !isPromptDismissed("advanced-ocr", ocrFingerprint, dismissedPromptFingerprints);

  if (!showChat && !showAdvancedOcr) return null;

  return (
    <section className="home-secondary-prompts" aria-label="Next steps">
      {showChat ? (
        <SecondaryPrompt
          actionLabel="Set up Chat"
          copy="Chat needs a configured provider before it can answer with your local context."
          fingerprint={chatFingerprint}
          icon={<MessageCircle size={16} aria-hidden="true" />}
          promptKey="chat-provider"
          title="Configure Chat provider"
          onAction={onSetUpChat}
          onDismiss={onDismiss}
        />
      ) : null}
      {showAdvancedOcr ? (
        <SecondaryPrompt
          actionLabel="Set up OCR"
          copy="Advanced OCR can improve extraction for PDFs and images, with extra model download and indexing cost."
          fingerprint={ocrFingerprint}
          icon={<FileSearch size={16} aria-hidden="true" />}
          promptKey="advanced-ocr"
          title="Improve OCR for documents"
          onAction={onSetUpAdvancedOcr}
          onDismiss={onDismiss}
        />
      ) : null}
    </section>
  );
}

function SecondaryPrompt({
  actionLabel,
  copy,
  fingerprint,
  icon,
  promptKey,
  title,
  onAction,
  onDismiss,
}: {
  actionLabel: string;
  copy: string;
  fingerprint: string;
  icon: ReactNode;
  promptKey: string;
  title: string;
  onAction?(): void;
  onDismiss(key: string, fingerprint: string): void;
}) {
  return (
    <article className="home-secondary-prompt">
      <div className="home-secondary-prompt-icon">{icon}</div>
      <div className="home-secondary-prompt-copy">
        <h3>{title}</h3>
        <p>{copy}</p>
      </div>
      <div className="home-secondary-prompt-actions">
        <button
          type="button"
          className="home-secondary-prompt-action"
          onClick={onAction}
        >
          {actionLabel}
        </button>
        <button
          type="button"
          className="home-secondary-prompt-dismiss"
          aria-label={`Dismiss ${title}`}
          onClick={() => onDismiss(promptKey, fingerprint)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function HomeSetupModal({
  children,
  title,
  onClose,
}: {
  children: ReactNode;
  title: string;
  onClose(): void;
}) {
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal home-setup-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Home setup</p>
            <h2 className="modal-title">{title}</h2>
          </div>
          <button
            aria-label="Close"
            className="modal-close"
            onClick={onClose}
            type="button"
          >
            x
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function isPromptDismissed(
  key: string,
  fingerprint: string,
  dismissedPromptFingerprints: Record<string, string>
): boolean {
  if (dismissedPromptFingerprints[key] === fingerprint) return true;
  return readDismissedPromptFingerprint(key) === fingerprint;
}

function dismissPrompt(
  key: string,
  fingerprint: string,
  setDismissedPromptFingerprints: Dispatch<
    SetStateAction<Record<string, string>>
  >
) {
  writeDismissedPromptFingerprint(key, fingerprint);
  setDismissedPromptFingerprints((current) => ({
    ...current,
    [key]: fingerprint,
  }));
}

function dismissedPromptStorageKey(key: string): string {
  return `cognios.homeOnboarding.dismissed.${key}`;
}

function readDismissedPromptFingerprint(key: string): string | null {
  try {
    return window.localStorage.getItem(dismissedPromptStorageKey(key));
  } catch {
    return null;
  }
}

function writeDismissedPromptFingerprint(key: string, fingerprint: string) {
  try {
    window.localStorage.setItem(dismissedPromptStorageKey(key), fingerprint);
  } catch {
    // localStorage may be unavailable in privacy modes; dismissal can stay session-only.
  }
}

function StatTile({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
  loading = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "neutral" | "ok" | "warn";
  loading?: boolean;
}) {
  return (
    <article className={`home-stat is-${tone}${loading ? " is-loading" : ""}`}>
      <div className="home-stat-icon">{loading ? <span className="home-skeleton home-skeleton-icon" aria-hidden="true" /> : icon}</div>
      <div>
        <p className="home-stat-label">{label}</p>
        {loading ? (
          <div className="home-stat-skeleton" aria-label={`${label} loading`}>
            <span className="home-skeleton home-skeleton-value" />
            <span className="home-skeleton home-skeleton-sub" />
          </div>
        ) : (
          <>
            <p className="home-stat-value">{value}</p>
            <p className="home-stat-sub">{sub}</p>
          </>
        )}
      </div>
    </article>
  );
}

function ActivityChart({
  days,
  windowDays,
  loading = false,
}: {
  days: SearchObservability["recentIndexedNodes"];
  windowDays: RecentIndexWindow;
  loading?: boolean;
}) {
  if (loading) {
    return <ChartSkeleton label="Recent indexing loading" variant={windowDays === 90 ? "heatmap" : "bar"} />;
  }
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
  loading = false,
  onCategoryChange,
}: {
  observability: SearchObservability | null;
  metric: LatencyMetricKey;
  category: LatencyCategoryKey | null;
  loading?: boolean;
  onCategoryChange: (category: LatencyCategoryKey) => void;
}) {
  if (loading) {
    return (
      <div className="home-latency-panel">
        <ChartSkeleton label="Latency loading" variant="line" />
        <LegendSkeleton count={3} />
      </div>
    );
  }
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
  loading = false,
}: {
  observability: SearchObservability | null;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="home-token-panel">
        <ChartSkeleton label="Token usage loading" variant="bar" />
        <LegendSkeleton count={3} />
      </div>
    );
  }
  const usage = observability?.tokenUsageByDay ?? [];
  const hasUsage = usage.some((day) => day.totalTokens > 0);
  if (!hasUsage) {
    return <p className="home-empty">No token usage reported.</p>;
  }
  const series = visibleTokenUsageSeries(tokenUsageSeries(usage));
  const visibleKeys = new Set(
    series.filter((item) => item.key !== "other").map((item) => item.key)
  );
  const rows = usage.map((day) => ({
    date: day.date,
    label: compactDate(day.date),
    totalTokens: day.totalTokens,
    ...Object.fromEntries(
      series.map((item) => [
        item.dataKey,
        day.segments.find((segment) => tokenSegmentKey(segment) === item.key)
          ?.totalTokens ?? 0,
      ])
    ),
    other: day.segments
      .filter((segment) => !visibleKeys.has(tokenSegmentKey(segment)))
      .reduce((total, segment) => total + segment.totalTokens, 0),
  }));
  return (
    <div className="home-token-panel">
      <div className="home-chart" role="img" aria-label="Token usage daily stacked bar chart">
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={CHART_LINE} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tick={{ fill: CHART_MUTED, fontSize: 10 }}
              interval={usage.length <= 7 ? 0 : 4}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              tick={{ fill: CHART_MUTED, fontSize: 10 }}
              tickFormatter={(value) => compactNumber(Number(value))}
              width={40}
            />
            <Tooltip
              contentStyle={tooltipStyle()}
              labelFormatter={(_label, payload) => payload?.[0]?.payload?.date ?? ""}
              formatter={(value, name) => [
                `${Number(value).toLocaleString()} tokens`,
                tokenSeriesLabel(String(name), series),
              ]}
            />
            {series.map((item, index) => (
              <Bar
                key={item.key}
                dataKey={item.dataKey}
                stackId="tokens"
                fill={TOKEN_SERIES_COLORS[index % TOKEN_SERIES_COLORS.length]}
                radius={index === series.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="home-token-legend" aria-label="Token usage model proportions">
        {series.map((item, index) => (
          <span key={item.key}>
            <i style={{ background: TOKEN_SERIES_COLORS[index % TOKEN_SERIES_COLORS.length] }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChartSkeleton({
  label,
  variant,
}: {
  label: string;
  variant: "bar" | "line" | "heatmap";
}) {
  if (variant === "heatmap") {
    return (
      <div className="home-heatmap is-loading" aria-label={label}>
        {Array.from({ length: 90 }).map((_, index) => (
          <span key={index} className="home-skeleton home-heat-cell" />
        ))}
      </div>
    );
  }
  return (
    <div className={`home-chart-skeleton is-${variant}`} aria-label={label}>
      {Array.from({ length: variant === "bar" ? 14 : 4 }).map((_, index) => (
        <span key={index} className="home-skeleton" />
      ))}
    </div>
  );
}

function LegendSkeleton({ count }: { count: number }) {
  return (
    <div className="home-legend-skeleton" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <span key={index} className="home-skeleton" />
      ))}
    </div>
  );
}

type TokenUsageDay = NonNullable<SearchObservability["tokenUsageByDay"]>[number];
type TokenUsageSegment = TokenUsageDay["segments"][number];

function tokenUsageSeries(days: TokenUsageDay[]) {
  const totals = new Map<string, { key: string; label: string; totalTokens: number }>();
  for (const day of days) {
    for (const segment of day.segments) {
      const key = tokenSegmentKey(segment);
      const current = totals.get(key) ?? {
        key,
        label: tokenSegmentLabel(segment),
        totalTokens: 0,
      };
      current.totalTokens += segment.totalTokens;
      totals.set(key, current);
    }
  }
  return Array.from(totals.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((item, index) => ({ ...item, dataKey: `model${index}` }));
}

function visibleTokenUsageSeries(
  series: Array<{ key: string; label: string; totalTokens: number; dataKey: string }>
) {
  const visible = series.slice(0, TOKEN_SERIES_COLORS.length - 1);
  const hidden = series.slice(TOKEN_SERIES_COLORS.length - 1);
  if (hidden.length === 0) return visible;
  return [
    ...visible,
    {
      key: "other",
      label: "Other",
      totalTokens: hidden.reduce((total, item) => total + item.totalTokens, 0),
      dataKey: "other",
    },
  ];
}

function tokenSegmentKey(segment: TokenUsageSegment): string {
  return `${segment.providerId}::${segment.model}`;
}

function tokenSegmentLabel(segment: TokenUsageSegment): string {
  return `${segment.model} · ${segment.providerId}`;
}

function tokenSeriesLabel(
  key: string,
  series: Array<{ dataKey: string; label: string }>
): string {
  return series.find((item) => item.dataKey === key)?.label ?? key;
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

function isLoading<T>(env: SidecarEnvelope<T> | null): boolean {
  return env === null || env.state === "initialising";
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
