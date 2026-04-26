import type { ExplorerNode } from "../types/explorer";

// Display-only breadcrumb showing the path to the active file in the center
// pane. Segments are not clickable in this iteration — clicking to
// "reveal in tree" is deferred. The layout passes the full path (root → leaf)
// as `nodes`.
export function Breadcrumbs({ nodes }: { nodes: ExplorerNode[] }) {
  if (nodes.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      {nodes.map((node, idx) => (
        <span className="breadcrumb-segment-group" key={node.id}>
          {idx > 0 ? <span className="breadcrumb-separator">/</span> : null}
          <span className="breadcrumb-segment">{node.name}</span>
        </span>
      ))}
    </nav>
  );
}
