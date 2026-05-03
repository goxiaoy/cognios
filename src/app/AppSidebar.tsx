import {
  BookOpen,
  Files,
  Home,
  MessageCircle,
  Search,
  Settings,
} from "lucide-react";

import { CogniLogo } from "./components/CogniLogo";
import { DownloadDock } from "./components/DownloadDock";

export type AppSection = "home" | "chat" | "explorer" | "memory" | "settings";

type NavItem = { id: AppSection; label: string; Icon: React.ComponentType<{ size?: number }> };

const NAV_ITEMS: NavItem[] = [
  { id: "home",     label: "Home",     Icon: Home },
  { id: "chat",     label: "Chat",     Icon: MessageCircle },
  { id: "explorer", label: "Explorer", Icon: Files },
  { id: "memory",   label: "Memory",   Icon: BookOpen },
];

export function AppSidebar({
  activeSection,
  onSelect,
  onOpenSearch,
}: {
  activeSection: AppSection;
  onSelect(section: AppSection): void;
  onOpenSearch(): void;
}) {
  const isSettingsActive = activeSection === "settings";
  return (
    <aside className="app-sidebar">
      <div className="app-brand">
        <CogniLogo aria-hidden className="app-brand-logo" size={26} />
        <div className="app-brand-text">
          <p className="app-brand-mark">CogniOS</p>
          <p className="app-brand-copy">Personal knowledge OS</p>
        </div>
      </div>

      <div className="app-ops">
        <button
          className="app-ops-item"
          onClick={onOpenSearch}
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

      <div className="app-sidebar-footer">
        <DownloadDock onOpenSettings={() => onSelect("settings")} />
        <button
          type="button"
          aria-current={isSettingsActive ? "page" : undefined}
          className={`app-nav-item app-sidebar-footer-item${isSettingsActive ? " is-active" : ""}`}
          onClick={() => onSelect("settings")}
        >
          <Settings size={15} aria-hidden="true" />
          <span className="app-nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
