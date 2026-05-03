import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, RefreshCcw } from "lucide-react";

import type {
  ModelDownloadEvent,
  ModelRoleStatus,
} from "../../lib/contracts/search";
import { searchClient } from "../../features/search/api/searchClient";
import { useModelDownloadProgress } from "../../features/settings/hooks/useModelDownloadProgress";
import { useSearchSubsystemStatus } from "../../features/settings/hooks/useSearchSubsystemStatus";

const ROLE_LABEL: Record<string, string> = {
  embedding: "Local GTE",
  reranker: "Local GTE Reranker",
  ocr: "Local OCR",
  captioner: "Local Gemma",
};

type DockEntry = {
  role: string;
  label: string;
  source: string | null;
  state: "downloading" | "verifying" | "queued" | "error";
  bytesDownloaded: number;
  bytesTotal: number | null;
  speedMBs: number;
  errorMessage: string | null;
};

/**
 * Sidebar-foot download chip + popover. Surfaces live model
 * download progress (one active + queued tail). Hidden when no
 * roles are downloading / queued / errored — the dock is ambient
 * and only appears when there's something to report.
 *
 * Wires straight to the live SSE feed (``useModelDownloadProgress``)
 * + the polled models envelope (``useSearchSubsystemStatus``);
 * doesn't carry its own state machine. Click the chip to open a
 * popover with full detail (% / size / speed / ETA / queue list +
 * Retry on error).
 */
export function DownloadDock({
  onOpenSettings,
}: {
  /** Called when the popover's "Manage in Settings" link is
   * clicked — routes the parent shell to the Settings section. */
  onOpenSettings?: () => void;
}) {
  const progress = useModelDownloadProgress();
  const { models } = useSearchSubsystemStatus(searchClient);
  const [open, setOpen] = useState(false);
  const lastBytesRef = useRef<
    Record<string, { bytes: number; ts: number; speed: number }>
  >({});
  const chipRef = useRef<HTMLButtonElement>(null);

  const entries = useMemo(
    () => buildEntries(models, progress, lastBytesRef.current),
    [models, progress]
  );

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (!chipRef.current) return;
      const target = event.target as Node;
      if (chipRef.current.contains(target)) return;
      const pop = document.querySelector(".dl-pop");
      if (pop && pop.contains(target)) return;
      setOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (entries.length === 0) {
    // Nothing to surface — dock stays collapsed.
    if (open) setOpen(false);
    return null;
  }

  const active =
    entries.find((e) => e.state !== "queued") ?? entries[0];
  const queued = entries.filter((e) => e.state === "queued");
  const totalCount = entries.length;
  const isError = active.state === "error";
  const pct = activePercent(active);

  async function handleRetry(role: string) {
    try {
      await searchClient.startModelDownload({ role });
    } catch {
      // ``models`` poll surfaces the error; quiet here.
    }
  }

  return (
    <div className="dl-host">
      <button
        ref={chipRef}
        className={`dl-chip${isError ? " is-error" : ""}${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
        title={`${active.label} — ${isError ? "failed" : `${pct.toFixed(0)}%`}`}
      >
        <span aria-hidden="true" className="dl-chip-glyph">
          {isError ? (
            <AlertTriangle size={11} />
          ) : (
            <span className="dl-chip-spinner" />
          )}
        </span>
        <span className="dl-chip-name">{active.label}</span>
        <span className="dl-chip-pct">
          {isError ? "failed" : `${pct.toFixed(0)}%`}
        </span>
        {totalCount > 1 ? (
          <span className="dl-chip-count">{totalCount}</span>
        ) : null}
        <span aria-hidden="true" className="dl-chip-bar">
          <span
            className="dl-chip-bar-fill"
            style={{ width: `${pct}%` }}
          />
        </span>
      </button>

      {open ? (
        <DownloadPopover
          active={active}
          activePercent={pct}
          anchor={chipRef.current}
          onOpenSettings={
            onOpenSettings
              ? () => {
                  onOpenSettings();
                  setOpen(false);
                }
              : undefined
          }
          onRetry={() => void handleRetry(active.role)}
          queued={queued}
        />
      ) : null}
    </div>
  );
}

function activePercent(entry: DockEntry): number {
  if (entry.bytesTotal && entry.bytesTotal > 0) {
    return Math.min(100, (entry.bytesDownloaded / entry.bytesTotal) * 100);
  }
  if (entry.state === "verifying") return 100;
  return 0;
}

function buildEntries(
  models: ReturnType<typeof useSearchSubsystemStatus>["models"],
  progress: Record<string, ModelDownloadEvent>,
  speedCache: Record<string, { bytes: number; ts: number; speed: number }>
): DockEntry[] {
  // Use the union of role names from BOTH sources so a freshly-
  // started download (live SSE event in flight, models poll not
  // yet refreshed) still surfaces, AND a freshly-finished download
  // (live event=ready) drops out even when the role table still
  // says "missing" before the next poll.
  const rolesByName: Record<string, ModelRoleStatus> =
    models && models.state === "ready" && models.data ? models.data.roles : {};
  const knownNames = new Set<string>([
    ...Object.keys(rolesByName),
    ...Object.keys(progress),
  ]);
  const roles = sortRoles(
    Array.from(knownNames).map((name) => rolesByName[name] ?? {
      role: name,
      state: "unknown",
      repo: "",
      commit: null,
      error: null,
    })
  );

  const out: DockEntry[] = [];
  for (const role of roles) {
    const evt = progress[role.role];
    const liveState = evt?.state;
    const isLiveDownloading =
      liveState === "downloading" || liveState === "verifying";
    const dockState = deriveDockState(role.state, liveState);
    if (!dockState) continue;

    const bytesDownloaded = evt?.bytesDownloaded ?? 0;
    const bytesTotal = evt?.bytesTotal ?? null;
    const speed = computeSpeed(role.role, bytesDownloaded, speedCache);

    out.push({
      role: role.role,
      label: ROLE_LABEL[role.role] ?? role.role,
      source: role.repo ? `huggingface.co/${role.repo}` : null,
      state: dockState,
      bytesDownloaded,
      bytesTotal,
      speedMBs: isLiveDownloading ? speed : 0,
      errorMessage: role.error ?? evt?.error ?? null,
    });
  }

  // Active items first, then queued.
  out.sort((a, b) => stateRank(a.state) - stateRank(b.state));
  return out;
}

function stateRank(state: DockEntry["state"]): number {
  if (state === "error") return 0;
  if (state === "downloading") return 1;
  if (state === "verifying") return 2;
  return 3; // queued
}

function deriveDockState(
  roleState: string,
  liveState: string | undefined
): DockEntry["state"] | null {
  // ``liveState=ready`` wins — a finished download drops out of
  // the dock even when the polled role table still reports
  // "missing" because the poll hasn't refreshed yet. Without this
  // override the chip would stay forever at the just-finished
  // role's last frame.
  if (liveState === "ready") return null;
  if (liveState === "downloading") return "downloading";
  if (liveState === "verifying") return "verifying";
  if (liveState === "queued") return "queued";
  if (liveState === "error" || roleState === "error") return "error";
  // ``missing`` without a live SSE event is NOT the same as
  // "queued for download" — most missing roles are just optional
  // models the user has never enabled (e.g. the 13 advanced-ocr
  // stages). Surfacing them as "queued" makes the dock advertise
  // downloads that aren't actually happening. The dock only lights
  // up when there's real evidence of activity (live events or
  // recorded errors). Roles parked on the manager's concurrency
  // semaphore emit a ``queued`` SSE frame, so they DO appear here.
  return null;
}

function sortRoles(roles: ModelRoleStatus[]): ModelRoleStatus[] {
  const ORDER = ["embedding", "reranker", "ocr", "captioner"] as const;
  const rank = new Map<string, number>(ORDER.map((r, i) => [r, i]));
  return [...roles].sort((a, b) => {
    const ra = rank.get(a.role) ?? ORDER.length;
    const rb = rank.get(b.role) ?? ORDER.length;
    if (ra !== rb) return ra - rb;
    return a.role.localeCompare(b.role);
  });
}

/** Rolling 1-window speed estimate (MB/s) by role. The SSE events
 * arrive every few hundred ms; the delta between consecutive
 * frames is good enough for an ambient indicator. */
function computeSpeed(
  role: string,
  bytes: number,
  cache: Record<string, { bytes: number; ts: number; speed: number }>
): number {
  const now = performance.now();
  const prev = cache[role];
  if (!prev || bytes < prev.bytes) {
    cache[role] = { bytes, ts: now, speed: prev?.speed ?? 0 };
    return prev?.speed ?? 0;
  }
  const dt = (now - prev.ts) / 1000;
  if (dt < 0.25) return prev.speed;
  const speed = (bytes - prev.bytes) / dt / (1024 * 1024);
  // Smooth a bit so the chip number doesn't twitch.
  const smoothed = prev.speed === 0 ? speed : prev.speed * 0.6 + speed * 0.4;
  cache[role] = { bytes, ts: now, speed: smoothed };
  return smoothed;
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function fmtETA(remainingBytes: number, speedMBs: number): string {
  if (!speedMBs || speedMBs <= 0 || remainingBytes <= 0) return "—";
  const remainingMB = remainingBytes / (1024 * 1024);
  const sec = remainingMB / speedMBs;
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

function DownloadPopover({
  active,
  activePercent,
  anchor,
  onOpenSettings,
  onRetry,
  queued,
}: {
  active: DockEntry;
  activePercent: number;
  anchor: HTMLButtonElement | null;
  onOpenSettings?: () => void;
  onRetry: () => void;
  queued: DockEntry[];
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = r.right + 10;
    const top = Math.min(window.innerHeight - 12, r.bottom);
    setPos({ left, top });
  }, [anchor]);

  if (!pos) return null;
  const isError = active.state === "error";
  const remaining =
    active.bytesTotal != null
      ? Math.max(0, active.bytesTotal - active.bytesDownloaded)
      : 0;

  return (
    <div
      className="dl-pop"
      role="dialog"
      aria-modal="false"
      aria-label="Model downloads"
      style={{ left: pos.left, top: pos.top, transform: "translateY(-100%)" }}
    >
      <span aria-hidden="true" className="dl-pop-arrow" />

      <div className="dl-pop-head">
        <span className="dl-pop-title">Downloads</span>
        <span className="dl-pop-sub">
          {isError ? "0" : "1"} active · {queued.length} queued
        </span>
      </div>

      <div className="dl-pop-active">
        <div className="dl-pop-active-head">
          <span className={`dl-pop-label${isError ? " is-error" : ""}`}>
            {isError ? "Failed" : active.state === "verifying" ? "Verifying" : "Downloading"}
          </span>
          <span className="dl-pop-name">{active.label}</span>
        </div>
        {active.source ? (
          <div className="dl-pop-source">{active.source}</div>
        ) : null}
        <div className="dl-pop-bar">
          <div
            className={`dl-pop-bar-fill${isError ? " is-error" : ""}`}
            style={{ width: `${activePercent}%` }}
          />
        </div>
        <div className="dl-pop-stats">
          {isError ? (
            <span className="dl-pop-err">
              {active.errorMessage ?? "Download failed"}
            </span>
          ) : (
            <>
              <span className="dl-pop-stat is-strong">
                {activePercent.toFixed(1)}%
              </span>
              {active.bytesTotal != null ? (
                <span className="dl-pop-stat">
                  {fmtSize(active.bytesDownloaded)} / {fmtSize(active.bytesTotal)}
                </span>
              ) : null}
              {active.speedMBs > 0 ? (
                <span className="dl-pop-stat">
                  {active.speedMBs.toFixed(1)} MB/s
                </span>
              ) : null}
              {active.bytesTotal != null && active.speedMBs > 0 ? (
                <span className="dl-pop-stat">
                  ETA {fmtETA(remaining, active.speedMBs)}
                </span>
              ) : null}
            </>
          )}
        </div>
        {isError ? (
          <div className="dl-pop-actions">
            <button className="dl-pop-btn" onClick={onRetry} type="button">
              <RefreshCcw size={11} /> Retry
            </button>
          </div>
        ) : null}
      </div>

      {queued.length > 0 ? (
        <div className="dl-pop-queue">
          {queued.map((q) => (
            <div className="dl-pop-item is-queued" key={q.role}>
              <span aria-hidden="true" className="dl-pop-item-glyph">
                <span className="dl-pop-item-dot" />
              </span>
              <span className="dl-pop-item-name">{q.label}</span>
              <span className="dl-pop-item-stat">
                {q.bytesTotal ? fmtSize(q.bytesTotal) : "—"}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="dl-pop-foot">
        <span className="dl-pop-foot-spacer" />
        {onOpenSettings ? (
          <button
            className="dl-pop-link"
            onClick={onOpenSettings}
            type="button"
          >
            Manage in Settings
            <ArrowRight size={10} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
