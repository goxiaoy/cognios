import { useCallback, useEffect, useState } from "react";
import { chatClient } from "../features/chat/api/chatClient";
import { ChatLayout } from "../features/chat/components/ChatLayout";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import { ExplorerStoreProvider } from "../features/explorer/store/ExplorerStoreContext";
import { HomeDashboard } from "../features/home/components/HomeDashboard";
import { searchClient } from "../features/search/api/searchClient";
import { SearchPalette } from "../features/search/components/SearchPalette";
import { SettingsLayout } from "../features/settings/components/SettingsLayout";
import { AppSection, AppSidebar } from "./AppSidebar";
import { useAutoModelDownload } from "./hooks/useAutoModelDownload";

const SECTION_LABELS: Record<AppSection, string> = {
  home: "Home",
  chat: "Chat",
  explorer: "Explorer",
  memory: "Memory Timeline",
  settings: "Settings",
};

export function App() {
  return (
    <ExplorerStoreProvider client={explorerClient}>
      <AppShell />
    </ExplorerStoreProvider>
  );
}

/**
 * Inner shell. Lives below ``ExplorerStoreProvider`` so any future
 * global keyboard binding can read store state without prop drilling.
 */
function AppShell() {
  const [activeSection, setActiveSection] = useState<AppSection>("explorer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sectionLabel = SECTION_LABELS[activeSection];

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // First-run model bootstrap: silently kick off downloads for the
  // mandatory features' local models if they're not on disk yet.
  // The DownloadDock in the sidebar surfaces progress.
  useAutoModelDownload(searchClient);

  // Global keyboard shortcut. Cmd/Ctrl+K toggles the palette; the
  // palette is the only search surface — filter chips, sort, and
  // cursor pagination all live inside it. Esc-to-close is owned by
  // the palette itself.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCmdOrCtrl) return;
      if (event.key.toLowerCase() !== "k") return;
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

          {activeSection === "settings" ? (
            <section className="settings-page-panel">
              <SettingsLayout client={searchClient} />
            </section>
          ) : null}

          {activeSection === "home" ? (
            <section className="home-page-panel">
              <HomeDashboard client={searchClient} />
            </section>
          ) : null}

          <div className={`app-panel${activeSection === "chat" ? " is-active" : ""}`}>
            <section className="chat-page-panel" aria-hidden={activeSection !== "chat"}>
              <ChatLayout
                client={chatClient}
                searchClient={searchClient}
                visible={activeSection === "chat"}
                onActivateSource={focusExplorer}
              />
            </section>
          </div>

          {activeSection !== "explorer" && activeSection !== "settings" && activeSection !== "chat" && activeSection !== "home" ? (
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
  );
}
