import { useEffect, useReducer } from "react";

import type { ModelDownloadEvent } from "../../lib/contracts/search";
import { useModelDownloadProgress } from "../../features/settings/hooks/useModelDownloadProgress";
import type { SearchClient } from "../../features/search/types/search";

/**
 * App-shell banner for first-run search-engine setup.
 *
 * Renders nothing when the user already has semantic search working
 * (Local GTE present + binding still local-gte) or when they have
 * explicitly skipped first-run setup. On a fresh install with no
 * model on disk, the banner shows a 5-second cancel countdown,
 * starts the download, surfaces progress / errors / retries, and
 * stays around as a "Set up in Settings" affordance if the user
 * skipped.
 *
 * State machine (mirrors the plan's Unit 5 design):
 *
 *   idle  →  consent (5s countdown)  →  downloading
 *      │       │                       │
 *      │       └─ user clicks Cancel ──→ skipped (persistent)
 *      │                               │
 *      │       ┌──────────────────────  ▼
 *      │       │    SSE state="error"     (auto-retry up to 3x)
 *      │       ▼
 *      │     failed (manual Retry / Skip)
 *      ▼
 *     done (auto-dismiss after 2s)
 */

const CONSENT_COUNTDOWN_SECONDS = 5;
const DONE_DISMISS_MS = 2000;
const MAX_AUTO_RETRIES = 3;

type BannerState =
  | { kind: "idle" }
  | { kind: "consent"; secondsLeft: number }
  | { kind: "downloading" }
  | { kind: "failed"; reason: string; autoRetries: number }
  | { kind: "skipped" }
  | { kind: "done" };

type Action =
  | { type: "settings-loaded"; needsFirstRun: boolean; alreadySkipped: boolean }
  | { type: "consent-tick" }
  | { type: "consent-elapsed" }
  | { type: "user-cancel" }
  | { type: "download-progress"; event: ModelDownloadEvent }
  | { type: "user-retry" }
  | { type: "user-skip" }
  | { type: "auto-dismiss" };

function reducer(state: BannerState, action: Action): BannerState {
  switch (action.type) {
    case "settings-loaded":
      if (action.alreadySkipped) return { kind: "skipped" };
      if (state.kind !== "idle") return state;
      if (!action.needsFirstRun) return state;
      return { kind: "consent", secondsLeft: CONSENT_COUNTDOWN_SECONDS };
    case "consent-tick":
      if (state.kind !== "consent") return state;
      return { kind: "consent", secondsLeft: state.secondsLeft - 1 };
    case "consent-elapsed":
      if (state.kind !== "consent") return state;
      return { kind: "downloading" };
    case "user-cancel":
      return { kind: "skipped" };
    case "download-progress": {
      if (action.event.role !== "embedding") return state;
      if (action.event.state === "ready") return { kind: "done" };
      if (action.event.state === "error") {
        const reason = action.event.error ?? "download failed";
        if (state.kind === "failed") {
          if (state.autoRetries < MAX_AUTO_RETRIES) {
            return {
              kind: "failed",
              reason,
              autoRetries: state.autoRetries + 1,
            };
          }
          return state;
        }
        return { kind: "failed", reason, autoRetries: 0 };
      }
      if (state.kind === "consent") return { kind: "downloading" };
      return state;
    }
    case "user-retry":
      return { kind: "downloading" };
    case "user-skip":
      return { kind: "skipped" };
    case "auto-dismiss":
      return { kind: "idle" };
    default:
      return state;
  }
}

export interface WorkspaceBannerProps {
  client: SearchClient;
  onOpenSettings: () => void;
}

export function WorkspaceBanner({
  client,
  onOpenSettings,
}: WorkspaceBannerProps) {
  const [state, dispatch] = useReducer(reducer, { kind: "idle" });
  const progress = useModelDownloadProgress();

  // Initial settings load + state init.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const env = await client.settings();
        if (cancelled) return;
        if (env.state !== "ready" || !env.data) return;
        const semantic = env.data.features["semantic-search"];
        const needsFirstRun =
          semantic?.providerId === "local-gte" &&
          progress.embedding === undefined;
        dispatch({
          type: "settings-loaded",
          needsFirstRun,
          alreadySkipped: env.data.firstRunSkipped,
        });
      } catch {
        // Silent: the banner is best-effort onboarding, not a hard
        // dependency. Settings UI will surface real diagnostics.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, progress.embedding]);

  // Consent countdown.
  useEffect(() => {
    if (state.kind !== "consent") return;
    if (state.secondsLeft <= 0) {
      dispatch({ type: "consent-elapsed" });
      void client.startModelDownload({ role: "embedding" });
      return;
    }
    const t = window.setTimeout(() => dispatch({ type: "consent-tick" }), 1000);
    return () => window.clearTimeout(t);
  }, [client, state]);

  // SSE progress feeds the reducer.
  useEffect(() => {
    if (!progress.embedding) return;
    dispatch({ type: "download-progress", event: progress.embedding });
  }, [progress.embedding]);

  // Auto-dismiss the "done" state after 2s.
  useEffect(() => {
    if (state.kind !== "done") return;
    const t = window.setTimeout(
      () => dispatch({ type: "auto-dismiss" }),
      DONE_DISMISS_MS
    );
    return () => window.clearTimeout(t);
  }, [state.kind]);

  // Persist firstRunSkipped to settings on user-skip / cancel so the
  // banner doesn't re-prompt on next launch.
  useEffect(() => {
    if (state.kind !== "skipped") return;
    let cancelled = false;
    void (async () => {
      try {
        const env = await client.settings();
        if (cancelled || env.state !== "ready" || !env.data) return;
        if (env.data.firstRunSkipped) return; // already persisted
        await client.updateSettings({
          ...env.data,
          firstRunSkipped: true,
        });
      } catch {
        // Best-effort: non-fatal if persistence fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, state.kind]);

  function handleCancel() {
    dispatch({ type: "user-cancel" });
  }

  function handleRetry() {
    dispatch({ type: "user-retry" });
    void client.startModelDownload({ role: "embedding" });
  }

  if (state.kind === "idle") return null;

  if (state.kind === "consent") {
    return (
      <div className="workspace-banner" role="status">
        <span>
          Setting up local search engine (75 MB from huggingface.co)…
          starting in {state.secondsLeft}s
        </span>
        <button
          type="button"
          className="workspace-banner-action"
          onClick={handleCancel}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.kind === "downloading") {
    const evt = progress.embedding;
    const percent =
      evt?.bytesTotal && evt.bytesTotal > 0
        ? Math.min(100, Math.round((evt.bytesDownloaded / evt.bytesTotal) * 100))
        : null;
    return (
      <div className="workspace-banner" role="status">
        <span>
          Downloading semantic search model
          {percent !== null ? ` — ${percent}%` : "…"}
        </span>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="workspace-banner is-done" role="status">
        <span>✓ Semantic search ready</span>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="workspace-banner is-error" role="status">
        <span>Setup failed: {state.reason}</span>
        <button
          type="button"
          className="workspace-banner-action"
          onClick={handleRetry}
        >
          Retry
        </button>
        <button
          type="button"
          className="workspace-banner-action"
          onClick={() => dispatch({ type: "user-skip" })}
        >
          Skip
        </button>
      </div>
    );
  }

  // skipped — persistent affordance
  return (
    <div className="workspace-banner is-muted" role="status">
      <span>Semantic search not configured</span>
      <button
        type="button"
        className="workspace-banner-action"
        onClick={onOpenSettings}
      >
        Set up in Settings
      </button>
    </div>
  );
}
