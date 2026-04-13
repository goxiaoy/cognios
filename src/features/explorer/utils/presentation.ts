import type { ExplorerNode } from "../types/explorer";

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric"
});

const RELATIVE_DAY = 24 * 60 * 60 * 1000;

export function formatNodeKindLabel(node: ExplorerNode) {
  switch (node.kind) {
    case "mount":
      return "MOUNT";
    case "url":
      return "WEB LINK";
    case "folder":
      return "FOLDER";
    case "directory":
      return "DIRECTORY";
    case "file":
      return fileBadgeFromName(node.name);
  }
}

export function formatInspectorKindLabel(node: ExplorerNode) {
  return `${formatNodeKindLabel(node)} · ${node.name.toUpperCase()}`;
}

export function formatNodeDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }

  return DATE_FORMATTER.format(parsed);
}

export function formatNodeSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function dateBucketLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference =
    (startOfToday.getTime() - startOfTarget.getTime()) / RELATIVE_DAY;
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());

  if (dayDifference <= 0) return "Today";
  if (dayDifference >= 1 && dayDifference < 2) return "Yesterday";
  if (startOfTarget >= startOfWeek) return "This Week";
  return "Earlier";
}

export function nodeGlyph(node: ExplorerNode) {
  switch (node.kind) {
    case "folder":
    case "directory":
      return "▣";
    case "mount":
      return "⧉";
    case "url":
      return "↗";
    case "file":
      return glyphFromName(node.name);
  }
}

export function isImageNode(node: ExplorerNode) {
  return node.kind === "file" && IMAGE_EXTENSIONS.has(extensionOf(node.name));
}

function fileBadgeFromName(name: string) {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "IMAGE";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "MARKDOWN";
  if (CODE_EXTENSIONS.has(extension)) return "CODE";
  return "DOCUMENT";
}

function glyphFromName(name: string) {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "◫";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "¶";
  if (CODE_EXTENSIONS.has(extension)) return "</>";
  return "•";
}

function extensionOf(name: string) {
  const extension = name.split(".").pop() ?? "";
  return extension.toLowerCase();
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "rs",
  "json",
  "css",
  "html",
  "yml",
  "yaml"
]);
