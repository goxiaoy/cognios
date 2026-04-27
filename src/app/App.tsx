import { useCallback, useEffect, useState } from "react";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import {
  ExplorerStoreProvider,
  useExplorerStoreContext,
} from "../features/explorer/store/ExplorerStoreContext";
import { searchClient } from "../features/search/api/searchClient";
import { SearchPalette } from "../features/search/components/SearchPalette";
import { AppSection, AppSidebar } from "./AppSidebar";

const SECTION_LABELS: Record<AppSection, string> = {
  home: "Home",
  chat: "Chat",
  explorer: "Explorer",
  memory: "Memory Timeline",
};

export function App() {
  return (
    <ExplorerStoreProvider client={explorerClient}>
      <AppShell />
    </ExplorerStoreProvider>
  );
}

/**
 * Inner shell. Lives below ``ExplorerStoreProvider`` so the global
 * Cmd+Shift+F binding can call into ``store.openSearchView`` and the
 * palette's "More results" affordance can carry the current query
 * forward into the dedicated view.
 */
function AppShell() {
  const [activeSection, setActiveSection] = useState<AppSection>("explorer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sectionLabel = SECTION_LABELS[activeSection];
  const store = useExplorerStoreContext();

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Global keyboard shortcuts. Listening at window level keeps them
  // active regardless of which surface holds focus.
  //   Cmd/Ctrl+K        → toggle the Cmd+K palette
  //   Cmd/Ctrl+Shift+F  → open the dedicated search view
  // Esc-to-close is owned by each surface itself.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCmdOrCtrl) return;
      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === "f" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setActiveSection("explorer");
        store.openSearchView("");
        return;
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [store]);

  // When activating a search result we want the user to land on the
  // Explorer section so the activation (note editor, markdown preview,
  // image viewer) is visible.
  const focusExplorer = useCallback(() => setActiveSection("explorer"), []);

  // Palette "More results" → close palette, switch to explorer,
  // open the dedicated view seeded with the in-flight query.
  const handlePaletteShowAll = useCallback(
    (query: string) => {
      setPaletteOpen(false);
      setActiveSection("explorer");
      store.openSearchView(query);
    },
    [store]
  );

  return (
    <main className="app-shell">
      <div className="app-titlebar" data-tauri-drag-region />
      <AppSidebar
        activeSection={activeSection}
        onSelect={setActiveSection}
        onOpenSearch={openPalette}
      />

      <div className="app-content">
        <header className="app-content-header">
          <h1 className="app-content-title">{sectionLabel}</h1>
        </header>

        <div className="app-content-body">
          <div className={`app-panel${activeSection === "explorer" ? " is-active" : ""}`}>
            <ExplorerLayout
              active={activeSection === "explorer"}
              client={explorerClient}
            />
          </div>

          {activeSection !== "explorer" ? (
            <section className="placeholder-panel">
              <p className="eyebrow">{sectionLabel}</p>
              <p className="muted-copy">
                This section is stubbed in Milestone 2 so the application shell and navigation contract can land before feature implementation.
              </p>
            </section>
          ) : null}
        </div>
      </div>

      {paletteOpen ? (
        <SearchPalette
          client={searchClient}
          onClose={closePalette}
          onActivate={focusExplorer}
          onShowAll={handlePaletteShowAll}
        />
      ) : null}
    </main>
  );
}
