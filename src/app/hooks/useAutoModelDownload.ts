import { useEffect, useRef } from "react";

import type { SearchClient } from "../../features/search/types/search";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

/**
 * Headless first-run model bootstrap. Replaces the Unit-13
 * WorkspaceBanner — the visible setup banner is gone (the sidebar
 * DownloadDock surfaces progress instead), but we still need to
 * actually kick off the missing local-model downloads when the
 * user's mandatory features are bound to local-* presets and the
 * weights aren't on disk yet.
 *
 * One-shot per app session: polls ``client.settings()`` until the
 * sidecar reports ``ready``, reads the bound providers, and fires
 * ``startModelDownload`` for each role whose model is still
 * missing — unless the on-disk ``firstRunSkipped`` flag is set
 * (legacy installs that explicitly cancelled the old banner).
 *
 * Skips roles whose model is already on disk (state = ``ready``).
 * Why: every ``startModelDownload`` invocation has the Rust
 * supervisor read the HF token from the macOS keychain, which
 * fires a Security Agent prompt on the first read after each
 * binary rebuild. Calling it for already-downloaded models meant
 * 2+ prompts on every launch in dev. Now we only ask for a token
 * when there's actually something to fetch.
 *
 * Quiet on failure: thrown IPC errors are swallowed; the user
 * still sees diagnostics on the Settings page if anything's off.
 */
export function useAutoModelDownload(client: SearchClient): void {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    let cancelled = false;
    let timer: number | null = null;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    async function attempt() {
      if (cancelled || firedRef.current) return;
      try {
        const env = await client.settings();
        if (cancelled) return;
        if (env.state !== "ready" || !env.data) {
          if (Date.now() < deadline) {
            timer = window.setTimeout(attempt, POLL_INTERVAL_MS);
          }
          return;
        }
        // Honor any pre-Unit-13 ``firstRunSkipped`` flag so users
        // who explicitly cancelled before don't suddenly get
        // surprise downloads on the next launch.
        if (env.data.firstRunSkipped) {
          firedRef.current = true;
          return;
        }
        const semantic = env.data.features["semantic-search"];
        const reranking = env.data.features["result-reranking"];
        const candidateRoles: string[] = [];
        if (semantic?.providerId === "local-gte") {
          candidateRoles.push("embedding");
        }
        if (
          reranking?.enabled &&
          reranking?.providerId === "local-gte-reranker"
        ) {
          candidateRoles.push("reranker");
        }
        if (candidateRoles.length === 0) {
          firedRef.current = true;
          return;
        }
        // Filter out roles whose model is already downloaded so we
        // don't trigger a needless keychain read in the supervisor.
        // If models_status isn't ready yet, retry on the next poll
        // tick rather than firing blind.
        const statusEnv = await client.modelsStatus();
        if (cancelled) return;
        if (statusEnv.state !== "ready" || !statusEnv.data) {
          if (Date.now() < deadline) {
            timer = window.setTimeout(attempt, POLL_INTERVAL_MS);
          }
          return;
        }
        const pendingRoles = candidateRoles.filter((role) => {
          const r = statusEnv.data?.roles[role];
          return !r || r.state !== "ready";
        });
        firedRef.current = true;
        for (const role of pendingRoles) {
          try {
            await client.startModelDownload({ role });
          } catch {
            // The DownloadDock will display any persistent error
            // via the polled models envelope — we don't surface
            // anything from here.
          }
        }
      } catch {
        if (!cancelled && Date.now() < deadline) {
          timer = window.setTimeout(attempt, POLL_INTERVAL_MS);
        }
      }
    }

    void attempt();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client]);
}
