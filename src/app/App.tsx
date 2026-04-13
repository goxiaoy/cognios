import { useState } from "react";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import { AppSection, AppSidebar } from "./AppSidebar";

const SECTION_LABELS: Record<AppSection, string> = {
  home: "Home",
  chat: "Chat",
  explorer: "Explorer",
  memory: "Memory Timeline",
};

export function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("explorer");
  const sectionLabel = SECTION_LABELS[activeSection];

  return (
    <main className="app-shell">
      <div className="app-titlebar" data-tauri-drag-region />
      <AppSidebar activeSection={activeSection} onSelect={setActiveSection} />

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
    </main>
  );
}
