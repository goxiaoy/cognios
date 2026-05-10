import type { ExplorerNode } from "../types/explorer";

const MAX_VISIBLE_SEGMENTS = 4;

type BreadcrumbItem =
  | { kind: "node"; node: ExplorerNode }
  | { kind: "overflow"; id: string; hiddenNames: string[] };

function getBreadcrumbItems(nodes: ExplorerNode[]): BreadcrumbItem[] {
  if (nodes.length <= MAX_VISIBLE_SEGMENTS) {
    return nodes.map((node) => ({ kind: "node", node }));
  }

  const hiddenNodes = nodes.slice(1, -2);
  return [
    { kind: "node", node: nodes[0] },
    { kind: "overflow", id: "breadcrumb-overflow", hiddenNames: hiddenNodes.map((node) => node.name) },
    ...nodes.slice(-2).map((node) => ({ kind: "node" as const, node })),
  ];
}

// Display-only breadcrumb showing the path to the active file in the center
// pane. Segments are not clickable in this iteration — clicking to
// "reveal in tree" is deferred.
export function Breadcrumbs({ nodes }: { nodes: ExplorerNode[] }) {
  if (nodes.length === 0) return null;

  const items = getBreadcrumbItems(nodes);
  const fullPath = nodes.map((node) => node.name).join(" / ");

  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs" title={fullPath}>
      {items.map((item, idx) => (
        <span
          className={`breadcrumb-segment-group${item.kind === "overflow" ? " is-overflow" : ""}`}
          key={item.kind === "node" ? item.node.id : item.id}
        >
          {idx > 0 ? <span className="breadcrumb-separator">/</span> : null}
          {item.kind === "node" ? (
            <span className="breadcrumb-segment" title={item.node.name}>
              {item.node.name}
            </span>
          ) : (
            <span
              aria-label={`Collapsed path: ${item.hiddenNames.join(" / ")}`}
              className="breadcrumb-segment breadcrumb-segment-overflow"
              title={item.hiddenNames.join(" / ")}
            >
              ...
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
