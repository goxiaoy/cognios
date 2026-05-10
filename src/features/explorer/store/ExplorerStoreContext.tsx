import { createContext, useContext, type ReactNode } from "react";
import type { ExplorerClient } from "../types/explorer";
import { useExplorerStore } from "./useExplorerStore";

/**
 * Hoisted explorer-store context.
 *
 * Until Unit 8 the store was a per-component hook called from
 * `ExplorerLayout` only. The Cmd+K palette (and Unit 9's dedicated
 * search view) need to share that store — they call `activateArtifact`
 * to open a result and read `snapshot` for the recently-modified
 * empty state. Hoisting the hook to a context provider mounted at
 * the App root gives the sidebar / palette / layout one instance.
 *
 * Consumers stay tight: read only the slice they need (`useExplorerStoreContext()`
 * returns the full shape but most callers destructure).
 */

type ExplorerStoreValue = ReturnType<typeof useExplorerStore>;

const ExplorerStoreContext = createContext<ExplorerStoreValue | null>(null);

export function ExplorerStoreProvider({
  client,
  children,
}: {
  client: ExplorerClient;
  children: ReactNode;
}) {
  const store = useExplorerStore(client);
  return (
    <ExplorerStoreContext.Provider value={store}>
      {children}
    </ExplorerStoreContext.Provider>
  );
}

export function useExplorerStoreContext(): ExplorerStoreValue {
  const value = useContext(ExplorerStoreContext);
  if (value === null) {
    throw new Error(
      "useExplorerStoreContext must be used inside <ExplorerStoreProvider>"
    );
  }
  return value;
}

export function useOptionalExplorerStoreContext(): ExplorerStoreValue | null {
  return useContext(ExplorerStoreContext);
}
