import type React from "react";
import {
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  Globe,
  HardDrive,
  Mic2
} from "lucide-react";
import type { ExplorerNode } from "../types/explorer";

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
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
    case "file":
      return fileBadgeFromName(node.name);
    case "note":
      return node.isVoiceNote ? "VOICE NOTE" : "NOTE";
  }
}

export function formatInspectorKindLabel(node: ExplorerNode) {
  return formatNodeKindLabel(node);
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

export function formatCompactNodeMeta(node: ExplorerNode) {
  switch (node.kind) {
    case "folder":
    case "mount":
      return "";
    case "note":
      return "";
    case "url":
      return "";
    case "file":
      return "";
  }
}

export function formatTreeDisclosurePath(nodes: ExplorerNode[]) {
  if (nodes.length === 0) return "";
  return nodes.map((node) => node.name).join(" / ");
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
      return "▣";
    case "mount":
      return "⧉";
    case "url":
      return "↗";
    case "file":
      return glyphFromName(node.name);
    case "note":
      return node.isVoiceNote ? "♬" : "¶";
  }
}

export function isImageNode(node: ExplorerNode) {
  return node.kind === "file" && IMAGE_EXTENSIONS.has(extensionOf(node.name));
}

export function isPdfNode(node: ExplorerNode) {
  return node.kind === "file" && extensionOf(node.name) === "pdf";
}

export function hasExtractArtifacts(node: ExplorerNode) {
  return isImageNode(node) || isPdfNode(node);
}

export function isMarkdownFile(node: ExplorerNode) {
  return node.kind === "file" && MARKDOWN_EXTENSIONS.has(extensionOf(node.name));
}

/** Plain-text file kinds we can render in the read-only preview
 * (no markdown decoration, no language colouring beyond basic
 * monospace rendering). Code extensions are intentionally excluded
 * here — they have their own ergonomics expectation that we don't
 * yet meet (no syntax highlight, no language picker). */
export function isPlainTextFile(node: ExplorerNode) {
  return node.kind === "file" && PLAIN_TEXT_EXTENSIONS.has(extensionOf(node.name));
}

/** Anything we can preview in the markdown/text pane — either
 * rendered as markdown (md/mdx) or as plain text (txt/log/...). */
export function isTextLikeFile(node: ExplorerNode) {
  return isMarkdownFile(node) || isPlainTextFile(node);
}

export function nodeIconComponent(node: ExplorerNode): React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }> {
  switch (node.kind) {
    case "folder": return Folder;
    case "mount":  return HardDrive;
    case "url":       return Globe;
    case "note":      return node.isVoiceNote ? Mic2 : FileText;
    case "file": {
      const ext = extensionOf(node.name);
      if (IMAGE_EXTENSIONS.has(ext))    return FileImage;
      if (MARKDOWN_EXTENSIONS.has(ext)) return FileText;
      if (CODE_EXTENSIONS.has(ext))     return FileCode;
      return File;
    }
  }
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

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx"]);
const PLAIN_TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "ini",
  "toml",
  "xml",
  "rtf",
  "cfg",
  "conf",
]);
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
