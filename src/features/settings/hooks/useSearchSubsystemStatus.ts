import { useEffect, useRef, useState } from "react";
import type {
  IndexStatus,
  ModelsStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";

const POLL_INTERVAL_MS = 5_000;

export interface SearchSubsystemStatus {
  models: SidecarEnvelope<ModelsStatus> | null;
  indexing: SidecarEnvelope<IndexStatus> | null;
  isLoading: boolean;
}

/**
 * Polls the search sidecar for model + indexing state every five
 * seconds. Returns the latest envelope for each plus a coarse
 * loading flag (true until the first poll completes).
 *
 * The hook intentionally keeps both responses on a single state
 * object — the Settings page renders them as siblings, so a single
 * tick that updates one but not the other (e.g., transient network
 * blip) is the right granularity.
 *
 * Polling is cheap (one HTTP round-trip per call, both endpoints
 * read in-memory state). The interval is long enough that a manual
 * action like a model download still feels responsive to inspect
 * via this page, while idle dev runs don't pay much overhead.
 */
export function useSearchSubsystemStatus(
  client: SearchClient
): SearchSubsystemStatus {
  const [models, setModels] = useState<SidecarEnvelope<ModelsStatus> | null>(
    null
  );
  const [indexing, setIndexing] = useState<SidecarEnvelope<IndexStatus> | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const [modelsEnv, indexingEnv] = await Promise.all([
          client.modelsStatus(),
          client.indexStatus(),
        ]);
        if (cancelledRef.current) return;
        setModels(modelsEnv);
        setIndexing(indexingEnv);
      } catch {
        // Network / supervisor faults surface as `unavailable`
        // envelopes already; only thrown errors land here. Don't
        // overwrite prior state — the user keeps the last good
        // snapshot until the next successful poll.
      } finally {
        if (!cancelledRef.current) setIsLoading(false);
      }
      if (!cancelledRef.current) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    void poll();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [client]);

  return { models, indexing, isLoading };
}
