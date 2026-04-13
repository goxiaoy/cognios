import { useEffect, useState } from "react";

export type AppSection = "home" | "chat" | "explorer" | "memory";

const NAV_ITEMS: Array<{ id: AppSection; label: string; icon: string }> = [
  { id: "home",     label: "Home",    icon: "⌂" },
  { id: "chat",     label: "Chat",    icon: "◈" },
  { id: "explorer", label: "Explorer",icon: "⊞" },
  { id: "memory",   label: "Memory",  icon: "⊙" },
];

export function AppSidebar({
  activeSection,
  onSelect
}: {
  activeSection: AppSection;
  onSelect(section: AppSection): void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (!searchOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSearchOpen(false);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [searchOpen]);

  return (
    <aside className="app-sidebar">
      <div className="app-brand">
        <p className="app-brand-mark">CogniOS</p>
        <p className="app-brand-copy">Personal knowledge OS</p>
      </div>

      <div className="app-ops">
        <button
          className="app-ops-item"
          onClick={() => setSearchOpen(true)}
          type="button"
        >
          <span className="app-ops-icon" aria-hidden="true">⌕</span>
          <span className="app-ops-label">Search</span>
          <span className="app-ops-hint">⌘K</span>
        </button>
      </div>

      <nav aria-label="Primary" className="app-nav">
        {NAV_ITEMS.map((item) => (
          <button
            aria-current={item.id === activeSection ? "page" : undefined}
            className={`app-nav-item${item.id === activeSection ? " is-active" : ""}`}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <span className="app-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="app-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      {searchOpen ? (
        <div
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Search"
          onClick={(e) => { if (e.target === e.currentTarget) setSearchOpen(false); }}
        >
          <div className="search-modal">
            <header className="search-modal-header">
              <p className="eyebrow">Search</p>
              <button
                aria-label="Close search"
                className="search-modal-close"
                onClick={() => setSearchOpen(false)}
                type="button"
              >
                ✕
              </button>
            </header>
            <p className="muted-copy">
              Search is not yet implemented in this milestone.
            </p>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
