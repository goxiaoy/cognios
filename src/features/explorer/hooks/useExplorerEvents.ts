import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { VFS_EVENT_NAME, type VfsChangeEvent } from "../../../lib/tauri/events";

export function useExplorerEvents(onRefresh: () => Promise<void>) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<VfsChangeEvent>(VFS_EVENT_NAME, async () => {
        await onRefresh();
      });
    })();

    return () => {
      void unlisten?.();
    };
  }, [onRefresh]);
}
