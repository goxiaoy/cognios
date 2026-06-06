import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { NodeStatusChangedEvent } from "../../../lib/contracts/nodeStatus";
import { NODE_STATUS_EVENT_NAME } from "../../../lib/tauri/events";

export function useNodeStatusEvents(onChanged: (event: NodeStatusChangedEvent) => void) {
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<NodeStatusChangedEvent>(NODE_STATUS_EVENT_NAME, async (event) => {
        if (cancelled) return;
        onChanged(event.payload);
      });
    })();

    return () => {
      cancelled = true;
      void unlisten?.();
    };
  }, [onChanged]);
}
