import { useState } from "react";
import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";
import { AppSection, AppSidebar } from "./AppSidebar";

export function App() {
  const [activeSection, setActiveSection] = useState<AppSection>("explorer");
  const sectionLabel =
    activeSection === "home" ? "Home" : activeSection === "chat" ? "Chat" : "Memory Timeline";

  return (
    <main className="app-shell">
      <AppSidebar activeSection={activeSection} onSelect={setActiveSection} />

      <section className="app-content">
        <div className={`app-panel${activeSection === "explorer" ? " is-active" : ""}`}>
          <ExplorerLayout
            active={activeSection === "explorer"}
            client={explorerClient}
          />
        </div>

        {activeSection !== "explorer" ? (
          <section className="workspace-panel placeholder-panel">
            <p className="eyebrow">{sectionLabel}</p>
            <h2>{sectionLabel}</h2>
            <p className="muted-copy">
              This section is stubbed in Milestone 2 so the application shell and navigation contract can land before feature implementation.
            </p>
          </section>
        ) : null}
      </section>
    </main>
  );
}
