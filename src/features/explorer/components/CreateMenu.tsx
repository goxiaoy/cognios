import { Plus } from "lucide-react";

export type CreateAction = "mount" | "folder" | "url";

const MENU_ITEMS: Array<{ action: CreateAction; label: string; hint: string }> = [
  { action: "mount",  label: "Mount Directory", hint: "Link a local folder" },
  { action: "folder", label: "New Folder",       hint: "Create in workspace" },
  { action: "url",    label: "Add URL",          hint: "Save a web resource" }
];

export function CreateMenu({ onSelect }: { onSelect(action: CreateAction): void }) {
  return (
    <div className="create-menu">
      <button
        aria-haspopup="menu"
        className="create-trigger"
        type="button"
      >
        <Plus size={13} aria-hidden="true" />
        New
      </button>
      <div className="create-dropdown" role="menu">
        {MENU_ITEMS.map(({ action, label, hint }) => (
          <button
            className="create-dropdown-item"
            key={action}
            onClick={() => onSelect(action)}
            role="menuitem"
            type="button"
          >
            <span className="create-item-label">{label}</span>
            <span className="create-item-hint">{hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
