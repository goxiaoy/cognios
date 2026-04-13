import type { ExplorerViewMode } from "../types/explorer";

const VIEW_MODES: ExplorerViewMode[] = ["grid", "list", "date"];

export function ViewModeToggle({
  value,
  onChange
}: {
  value: ExplorerViewMode;
  onChange(mode: ExplorerViewMode): void;
}) {
  return (
    <div className="view-mode-toggle" role="tablist" aria-label="Content view mode">
      {VIEW_MODES.map((mode) => (
        <button
          aria-selected={mode === value}
          className={`view-mode-button${mode === value ? " is-active" : ""}`}
          key={mode}
          onClick={() => onChange(mode)}
          role="tab"
          type="button"
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
