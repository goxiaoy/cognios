import { Fragment } from "react";
import type { SearchResult } from "../types/search";
import { File, FileText, Folder, Globe, HardDrive } from "lucide-react";

const KIND_LABELS: Record<string, string> = {
  note: "Note",
  file: "File",
  url: "URL",
  folder: "Folder",
  mount: "Mount",
};

/**
 * One row in the Cmd+K result list.
 *
 * Snippet rendering — XSS hardening (SEC-FINDING-002). Snippets
 * carry text from arbitrary user files, OCR output, and AI-generated
 * captions. They MUST render as React text nodes only — never via
 * `dangerouslySetInnerHTML`. The sidecar returns `matchOffsets` as
 * `[start, end)` character ranges within the snippet; this component
 * splits the snippet at those boundaries and wraps each match in a
 * `<mark>` element built via JSX text nodes only.
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
          <div className="search-result-snippet">
            <HighlightedSnippet
              snippet={result.snippet}
              offsets={result.matchOffsets}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Render a snippet with `<mark>` spans at the supplied offsets. Each
 * slice of `snippet` is rendered as a React text node — there is no
 * HTML-string interpolation or `dangerouslySetInnerHTML` anywhere on
 * this path, so a snippet containing markup-shaped characters cannot
 * inject DOM.
 *
 * Out-of-range offsets are clamped + dropped silently so a sidecar
 * bug can't crash the row. The expected invariants the sidecar
 * promises (sorted, non-overlapping, within-bounds) are
 * defence-in-depth: this function tolerates violations.
 */
export function HighlightedSnippet({
  snippet,
  offsets,
}: {
  snippet: string;
  offsets?: [number, number][];
}) {
  if (!offsets || offsets.length === 0) {
    return <>{snippet}</>;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const [rawStart, rawEnd] of offsets) {
    const start = Math.max(0, Math.min(rawStart, snippet.length));
    const end = Math.max(start, Math.min(rawEnd, snippet.length));
    if (start === end) continue;
    if (start < cursor) continue; // overlap with prior; skip
    if (cursor < start) parts.push(snippet.slice(cursor, start));
    parts.push(<mark key={key++}>{snippet.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return (
    <>
      {parts.map((p, idx) => (
        <Fragment key={idx}>{p}</Fragment>
      ))}
    </>
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
    case "file":
    default: {
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (["md", "mdx", "txt", "markdown"].includes(ext)) return FileText;
      return File;
    }
  }
}
