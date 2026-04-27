import type { SearchResult } from "../types/search";
import { File, FileText, Folder, Globe, HardDrive } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  note: "Note",
  file: "File",
  url: "URL",
  folder: "Folder",
  mount: "Mount",
  directory: "Directory",
};

/**
 * One row in the Cmd+K result list.
 *
 * Snippet rendering — XSS hardening (carries forward SEC-007). Snippets
 * carry text from arbitrary user files, OCR output, and AI-generated
 * captions. They MUST render as React text nodes only — never via
 * `dangerouslySetInnerHTML`. Match highlighting is a v1b concern;
 * until offset metadata ships from the sidecar this component renders
 * the raw snippet string and lets the user spot matches visually.
 */
export function SearchResultRow({
  result,
  active,
  rowId,
  onActivate,
  onHover,
}: {
  result: SearchResult;
  active: boolean;
  rowId: string;
  onActivate(): void;
  onHover?(): void;
}) {
  const Icon = iconForKind(result.kind, result.name);
  const kindLabel = KIND_LABELS[result.kind] ?? result.kind;

  return (
    <li
      id={rowId}
      role="option"
      aria-selected={active}
      className={`search-result-row${active ? " is-active" : ""}`}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <span className="search-result-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <div className="search-result-body">
        <div className="search-result-title">
          <span className="search-result-name">{result.name}</span>
          <span className="search-result-kind">{kindLabel}</span>
        </div>
        {result.snippet ? (
          <div className="search-result-snippet">{result.snippet}</div>
        ) : null}
      </div>
    </li>
  );
}

function iconForKind(kind: string, name: string) {
  switch (kind) {
    case "note":
      return FileText;
    case "url":
      return Globe;
    case "folder":
      return Folder;
    case "mount":
      return HardDrive;
    case "directory":
      return Folder;
    case "file":
    default: {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (["md", "mdx", "txt", "markdown"].includes(ext)) return FileText;
      return File;
    }
  }
}
