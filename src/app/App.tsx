import { useCallback, useEffect, useState } from "react";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import { ExplorerStoreProvider } from "../features/explorer/store/ExplorerStoreContext";
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
  const [activeSection, setActiveSection] = useState<AppSection>("explorer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sectionLabel = SECTION_LABELS[activeSection];

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Global Cmd+K / Ctrl+K shortcut. Listening at window level keeps the
  // shortcut active regardless of which surface holds focus. Esc-to-close
  // is owned by the palette itself.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCmdOrCtrl) return;
      if (event.key.toLowerCase() !== "k") return;
      // Allow Cmd+Shift+K and Cmd+Alt+K (browser shortcuts) to pass through.
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // When activating a search result we want the user to land on the
  // Explorer section so the activation (note editor, markdown preview,
  // image viewer) is visible.
  const focusExplorer = useCallback(() => setActiveSection("explorer"), []);

  return (
    <ExplorerStoreProvider client={explorerClient}>
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
          />
        ) : null}
      </main>
    </ExplorerStoreProvider>
  );
}
