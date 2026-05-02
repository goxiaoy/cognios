import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { ModelDownloadEvent } from "../../../lib/contracts/search";

const EVENT_NAME = "models/progress";

export type ProgressByRole = Record<string, ModelDownloadEvent>;

/**
 * Subscribes to the Rust-emitted ``models/progress`` Tauri events for
 * the lifetime of the calling component. Returns a map keyed on
 * ``role``; each entry holds the most-recent event for that role.
 *
 * The hook does not initiate downloads — that's
 * ``client.startModelDownload`` — and does not retain progress past
 * a ``state: "ready"`` or ``state: "error"`` event. The Settings
 * page reads the same map to drive its progress bars; on completion
 * the entry stays put until the next mount.
 */
export function useModelDownloadProgress(): ProgressByRole {
  const [byRole, setByRole] = useState<ProgressByRole>({});

  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<ModelDownloadEvent>(EVENT_NAME, (event) => {
      if (cancelled) return;
      setByRole((prev) => ({ ...prev, [event.payload.role]: event.payload }));
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((u) => u()).catch(() => {});
    };
  }, []);

  return byRole;
}
