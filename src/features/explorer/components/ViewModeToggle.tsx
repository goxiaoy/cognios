import { CalendarDays, LayoutGrid, List } from "lucide-react";
import type { ExplorerViewMode } from "../types/explorer";

const VIEW_MODE_CONFIG: Array<{
  mode: ExplorerViewMode;
  Icon: React.ComponentType<{ size?: number }>;
  label: string;
}> = [
  { mode: "grid", Icon: LayoutGrid, label: "Grid view" },
  { mode: "list", Icon: List,       label: "List view" },
  { mode: "date", Icon: CalendarDays, label: "Date view" },
];

export function ViewModeToggle({
  value,
  onChange
}: {
  value: ExplorerViewMode;
  onChange(mode: ExplorerViewMode): void;
}) {
  return (
    <div className="view-mode-toggle" role="tablist" aria-label="Content view mode">
      {VIEW_MODE_CONFIG.map(({ mode, Icon, label }) => (
        <button
          aria-label={label}
          aria-selected={mode === value}
          className={`view-mode-button${mode === value ? " is-active" : ""}`}
          key={mode}
          onClick={() => onChange(mode)}
          role="tab"
          type="button"
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
