import { useEffect, useRef } from "react";

import {
  presetById,
  presetOwnsRole,
} from "../../features/settings/data/providerPresets";
import type { SearchClient } from "../../features/search/types/search";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

/**
 * Headless model bootstrap. Walks every feature in settings and,
 * for each enabled feature bound to a local provider, fires
 * ``startModelDownload`` for any owned role whose model isn't
 * already on disk.
 *
 * Generic over the feature catalog rather than hardcoding
 * ``embedding`` / ``reranker``: when the user enables advanced
 * OCR with the local PP-StructureV3 provider, all 13 stages are
 * picked up here on the next app launch (FeatureRow fires the
 * same logic on the *bind* event; this hook covers cold-starts
 * where the binding was set in a prior session).
 *
 * One-shot per app session: polls ``client.settings()`` until the
 * sidecar reports ``ready``, then reads ``modelsStatus`` once and
 * fires the necessary downloads. Skips roles whose state is
 * already ``ready`` (or already ``downloading``) so re-launches
 * don't re-issue work the supervisor would just no-op anyway.
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
        // Collect the set of provider ids any enabled feature is
        // bound to. Using a Set avoids re-issuing downloads when
        // multiple features share a provider.
        const boundLocalProviderIds = new Set<string>();
        for (const feature of Object.values(env.data.features)) {
          if (!feature?.enabled || !feature.providerId) continue;
          const preset = presetById(feature.providerId);
          if (!preset || preset.providerType !== "local") continue;
          if (!preset.localRoleId) continue; // e.g. local-paddleocr (bundled)
          boundLocalProviderIds.add(preset.providerId);
        }
        if (boundLocalProviderIds.size === 0) {
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
        const allRoles = statusEnv.data.roles;
        const pendingRoles: string[] = [];
        for (const providerId of boundLocalProviderIds) {
          const preset = presetById(providerId);
          if (!preset) continue;
          for (const [roleId, status] of Object.entries(allRoles)) {
            if (!presetOwnsRole(preset, roleId)) continue;
            if (status.state === "ready" || status.state === "downloading") {
              continue;
            }
            pendingRoles.push(roleId);
          }
        }
        firedRef.current = true;
        // Fire all pending roles in parallel — each
        // ``startModelDownload`` opens its own SSE stream that stays
        // alive until the download completes. ``await``ing them in
        // sequence would let only one stream open at a time, which
        // defeats the sidecar's concurrency cap (the manager wants
        // to see all N requests so it can park N-2 on the semaphore
        // and emit ``queued`` frames). We don't await the resolved
        // promises here — the dock surfaces progress via the live
        // ``models/progress`` Tauri events.
        for (const role of pendingRoles) {
          void client.startModelDownload({ role }).catch(() => {
            // The DownloadDock will display any persistent error
            // via the polled models envelope — we don't surface
            // anything from here.
          });
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
