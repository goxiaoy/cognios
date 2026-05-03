import { useEffect, useReducer } from "react";

import type { ModelDownloadEvent } from "../../lib/contracts/search";
import { useModelDownloadProgress } from "../../features/settings/hooks/useModelDownloadProgress";
import type { SearchClient } from "../../features/search/types/search";

/**
 * App-shell banner for first-run search-engine setup.
 *
 * Both mandatory features (semantic-search + result-reranking) need
 * their local model on disk before search works at full quality.
 * The banner detects which of the two are missing on first launch,
 * shows a 5-second cancel countdown, kicks off the downloads, and
 * sticks around until every pending role has finished — or the user
 * explicitly skipped, in which case it converts to a persistent
 * "Set up in Settings" affordance.
 *
 * State machine:
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
 *     done (auto-dismiss after 2s, only when every pending role
 *           reported state="ready")
 */

const CONSENT_COUNTDOWN_SECONDS = 5;
const DONE_DISMISS_MS = 2000;
const MAX_AUTO_RETRIES = 3;

const ROLE_LABEL: Record<string, string> = {
  embedding: "semantic search model",
  reranker: "reranker model",
};

type BannerState =
  | { kind: "idle" }
  | { kind: "consent"; secondsLeft: number; pendingRoles: readonly string[] }
  | { kind: "downloading"; pendingRoles: readonly string[] }
  | {
      kind: "failed";
      reason: string;
      autoRetries: number;
      failedRole: string;
      pendingRoles: readonly string[];
    }
  | { kind: "skipped" }
  | { kind: "done" };

type Action =
  | {
      type: "settings-loaded";
      pendingRoles: readonly string[];
      alreadySkipped: boolean;
    }
  | { type: "consent-tick" }
  | { type: "consent-elapsed" }
  | { type: "user-cancel" }
  | { type: "download-progress"; event: ModelDownloadEvent }
  | { type: "user-retry" }
  | { type: "user-skip" }
  | { type: "auto-dismiss" };

function pendingFromState(state: BannerState): readonly string[] {
  if (
    state.kind === "consent" ||
    state.kind === "downloading" ||
    state.kind === "failed"
  ) {
    return state.pendingRoles;
  }
  return [];
}

function reducer(state: BannerState, action: Action): BannerState {
  switch (action.type) {
    case "settings-loaded":
      if (action.alreadySkipped) return { kind: "skipped" };
      if (state.kind !== "idle") return state;
      if (action.pendingRoles.length === 0) return state;
      return {
        kind: "consent",
        secondsLeft: CONSENT_COUNTDOWN_SECONDS,
        pendingRoles: action.pendingRoles,
      };
    case "consent-tick":
      if (state.kind !== "consent") return state;
      return {
        kind: "consent",
        secondsLeft: state.secondsLeft - 1,
        pendingRoles: state.pendingRoles,
      };
    case "consent-elapsed":
      if (state.kind !== "consent") return state;
      return { kind: "downloading", pendingRoles: state.pendingRoles };
    case "user-cancel":
      return { kind: "skipped" };
    case "download-progress": {
      const tracked = pendingFromState(state);
      if (!tracked.includes(action.event.role)) return state;
      if (action.event.state === "ready") {
        const rest = tracked.filter((r) => r !== action.event.role);
        if (rest.length === 0) return { kind: "done" };
        if (state.kind === "consent") {
          return {
            kind: "consent",
            secondsLeft: state.secondsLeft,
            pendingRoles: rest,
          };
        }
        return { kind: "downloading", pendingRoles: rest };
      }
      if (action.event.state === "error") {
        const reason = action.event.error ?? "download failed";
        if (state.kind === "failed" && state.failedRole === action.event.role) {
          if (state.autoRetries < MAX_AUTO_RETRIES) {
            return {
              kind: "failed",
              reason,
              autoRetries: state.autoRetries + 1,
              failedRole: action.event.role,
              pendingRoles: state.pendingRoles,
            };
          }
          return state;
        }
        return {
          kind: "failed",
          reason,
          autoRetries: 0,
          failedRole: action.event.role,
          pendingRoles: tracked,
        };
      }
      if (state.kind === "consent") {
        return { kind: "downloading", pendingRoles: state.pendingRoles };
      }
      return state;
    }
    case "user-retry":
      if (state.kind !== "failed") return state;
      return { kind: "downloading", pendingRoles: state.pendingRoles };
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
        const reranking = env.data.features["result-reranking"];
        const pendingRoles: string[] = [];
        if (
          semantic?.providerId === "local-gte" &&
          progress.embedding === undefined
        ) {
          pendingRoles.push("embedding");
        }
        if (
          reranking?.enabled &&
          reranking?.providerId === "local-gte-reranker" &&
          progress.reranker === undefined
        ) {
          pendingRoles.push("reranker");
        }
        dispatch({
          type: "settings-loaded",
          pendingRoles,
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
  }, [client, progress.embedding, progress.reranker]);

  // Consent countdown — kicks off all pending downloads at zero.
  useEffect(() => {
    if (state.kind !== "consent") return;
    if (state.secondsLeft <= 0) {
      dispatch({ type: "consent-elapsed" });
      for (const role of state.pendingRoles) {
        void client.startModelDownload({ role });
      }
      return;
    }
    const t = window.setTimeout(() => dispatch({ type: "consent-tick" }), 1000);
    return () => window.clearTimeout(t);
  }, [client, state]);

  // SSE progress feeds the reducer for every role we may be tracking.
  useEffect(() => {
    if (progress.embedding) {
      dispatch({ type: "download-progress", event: progress.embedding });
    }
  }, [progress.embedding]);
  useEffect(() => {
    if (progress.reranker) {
      dispatch({ type: "download-progress", event: progress.reranker });
    }
  }, [progress.reranker]);

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

  function handleRetry(role: string) {
    dispatch({ type: "user-retry" });
    void client.startModelDownload({ role });
  }

  if (state.kind === "idle") return null;

  if (state.kind === "consent") {
    return (
      <div className="workspace-banner" role="status">
        <span>
          Setting up local search engine ({state.pendingRoles.length} model
          {state.pendingRoles.length === 1 ? "" : "s"} from huggingface.co)…
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
    const activeRole = state.pendingRoles[0];
    const evt = activeRole ? progress[activeRole] : undefined;
    const percent =
      evt?.bytesTotal && evt.bytesTotal > 0
        ? Math.min(100, Math.round((evt.bytesDownloaded / evt.bytesTotal) * 100))
        : null;
    const label = activeRole
      ? ROLE_LABEL[activeRole] ?? `${activeRole} model`
      : "search models";
    const remainder =
      state.pendingRoles.length > 1
        ? ` (${state.pendingRoles.length - 1} more queued)`
        : "";
    return (
      <div className="workspace-banner" role="status">
        <span>
          Downloading {label}
          {percent !== null ? ` — ${percent}%` : "…"}
          {remainder}
        </span>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="workspace-banner is-done" role="status">
        <span>✓ Search models ready</span>
      </div>
    );
  }

  if (state.kind === "failed") {
    const failedLabel = ROLE_LABEL[state.failedRole] ?? `${state.failedRole} model`;
    return (
      <div className="workspace-banner is-error" role="status">
        <span>
          {failedLabel} setup failed: {state.reason}
        </span>
        <button
          type="button"
          className="workspace-banner-action"
          onClick={() => handleRetry(state.failedRole)}
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
