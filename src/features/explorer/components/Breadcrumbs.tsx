import { House } from "lucide-react";
import type { ExplorerNode } from "../types/explorer";

export function Breadcrumbs({
  nodes,
  onSelect
}: {
  nodes: ExplorerNode[];
  onSelect(nodeId: string | null): void;
}) {
  const isRoot = nodes.length === 0;

  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <button
        className={`breadcrumb-home${isRoot ? " is-root" : ""}`}
        onClick={() => onSelect(null)}
        title="Workspace root"
        type="button"
      >
        <House size={14} />
      </button>

      {nodes.map((node) => (
        <>
          <span className="breadcrumb-separator" key={`sep-${node.id}`}>/</span>
          <button
            className="breadcrumb-link"
            key={node.id}
            onClick={() => onSelect(node.id)}
            type="button"
          >
            {node.name}
          </button>
        </>
      ))}
    </nav>
  );
}
