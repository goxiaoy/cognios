import type { ExplorerNode } from "../types/explorer";

export type ExplorerTreeSort =
  | "created-desc"
  | "created-asc"
  | "modified-desc"
  | "modified-asc"
  | "name-asc"
  | "name-desc";

export const DEFAULT_EXPLORER_TREE_SORT: ExplorerTreeSort = "created-desc";

export function sortExplorerTree(
  nodes: ExplorerNode[],
  sort: ExplorerTreeSort
): ExplorerNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortExplorerTree(node.children, sort),
    }))
    .sort((left, right) => compareExplorerNodes(left, right, sort));
}

function compareExplorerNodes(
  left: ExplorerNode,
  right: ExplorerNode,
  sort: ExplorerTreeSort
) {
  const [field, direction] = sort.split("-") as [
    "created" | "modified" | "name",
    "asc" | "desc",
  ];

  let primary = 0;
  if (field === "created") {
    primary = compareDates(left.createdAt, right.createdAt, direction);
  } else if (field === "modified") {
    primary = compareDates(left.modifiedAt, right.modifiedAt, direction);
  } else {
    primary = compareNames(left.name, right.name, direction);
  }

  return (
    primary ||
    compareNames(left.name, right.name, "asc") ||
    left.id.localeCompare(right.id)
  );
}

function compareDates(left: string, right: string, direction: "asc" | "desc") {
  const leftTime = parseNodeDate(left);
  const rightTime = parseNodeDate(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;

  const delta = leftTime - rightTime;
  return direction === "asc" ? delta : -delta;
}

function compareNames(left: string, right: string, direction: "asc" | "desc") {
  const delta = left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  return direction === "asc" ? delta : -delta;
}

function parseNodeDate(value: string) {
  return Date.parse(value.replace(" ", "T"));
}
