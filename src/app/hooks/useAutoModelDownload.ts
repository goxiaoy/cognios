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
        const pendingRoles: string[] = [];
        if (semantic?.providerId === "local-gte") {
          pendingRoles.push("embedding");
        }
        if (
          reranking?.enabled &&
          reranking?.providerId === "local-gte-reranker"
        ) {
          pendingRoles.push("reranker");
        }
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
