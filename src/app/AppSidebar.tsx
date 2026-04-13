import { useEffect, useState } from "react";
import { BookOpen, Files, Home, MessageCircle, Search, X } from "lucide-react";

export type AppSection = "home" | "chat" | "explorer" | "memory";

type NavItem = { id: AppSection; label: string; Icon: React.ComponentType<{ size?: number }> };

const NAV_ITEMS: NavItem[] = [
  { id: "home",     label: "Home",    Icon: Home },
  { id: "chat",     label: "Chat",    Icon: MessageCircle },
  { id: "explorer", label: "Explorer",Icon: Files },
  { id: "memory",   label: "Memory",  Icon: BookOpen },
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
          <Search className="app-ops-icon" size={15} aria-hidden="true" />
          <span className="app-ops-label">Search</span>
          <span className="app-ops-hint">⌘K</span>
        </button>
      </div>

      <nav aria-label="Primary" className="app-nav">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            aria-current={id === activeSection ? "page" : undefined}
            className={`app-nav-item${id === activeSection ? " is-active" : ""}`}
            key={id}
            onClick={() => onSelect(id)}
            type="button"
          >
            <Icon size={15} aria-hidden="true" />
            <span className="app-nav-label">{label}</span>
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
                <X size={14} />
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
