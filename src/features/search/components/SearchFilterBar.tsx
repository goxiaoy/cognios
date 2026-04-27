import type { ExplorerNode } from "../../explorer/types/explorer";
import type { SearchSort } from "../../../lib/contracts/search";

export type KindFilter =
  | "note"
  | "file"
  | "url"
  | "folder"
  | "mount"
  | "directory";

export const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "note", label: "Notes" },
  { value: "file", label: "Files" },
  { value: "url", label: "URLs" },
  { value: "folder", label: "Folders" },
  { value: "mount", label: "Mounts" },
];

export interface SearchFilters {
  kinds: KindFilter[];
  mountId: string | null;
  modifiedAfter: string | null; // YYYY-MM-DD
  modifiedBefore: string | null; // YYYY-MM-DD
}

export const EMPTY_FILTERS: SearchFilters = {
  kinds: [],
  mountId: null,
  modifiedAfter: null,
  modifiedBefore: null,
};

/**
 * Filter + sort controls for the dedicated search view.
 *
 * Filters serialise into the same inline-syntax string the Cmd+K
 * palette uses (``kind:note,file mount:<uuid> modified:>2026-01-01``)
 * so the same Rust command + sidecar parser handle both. ``sort`` is
 * a separate field on the IPC payload.
 */
export function SearchFilterBar({
  filters,
  sort,
  mounts,
  onFiltersChange,
  onSortChange,
}: {
  filters: SearchFilters;
  sort: SearchSort;
  mounts: ExplorerNode[];
  onFiltersChange(next: SearchFilters): void;
  onSortChange(next: SearchSort): void;
}) {
  function toggleKind(kind: KindFilter) {
    const next = filters.kinds.includes(kind)
      ? filters.kinds.filter((k) => k !== kind)
      : [...filters.kinds, kind];
    onFiltersChange({ ...filters, kinds: next });
  }

  return (
    <div className="search-filter-bar" role="group" aria-label="Search filters">
      <fieldset className="search-filter-group">
        <legend className="search-filter-legend">Kind</legend>
        <div className="search-filter-chips">
          {KIND_OPTIONS.map((opt) => {
            const active = filters.kinds.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                className={`search-filter-chip${active ? " is-active" : ""}`}
                onClick={() => toggleKind(opt.value)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="search-filter-group">
        <span className="search-filter-legend">Mount</span>
        <select
          className="search-filter-select"
          value={filters.mountId ?? ""}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              mountId: event.target.value || null,
            })
          }
        >
          <option value="">Any mount</option>
          {mounts.map((mount) => (
            <option key={mount.id} value={mount.id}>
              {mount.name}
            </option>
          ))}
        </select>
      </label>

      <label className="search-filter-group">
        <span className="search-filter-legend">Modified after</span>
        <input
          type="date"
          className="search-filter-date"
          value={filters.modifiedAfter ?? ""}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              modifiedAfter: event.target.value || null,
            })
          }
        />
      </label>

      <label className="search-filter-group">
        <span className="search-filter-legend">Modified before</span>
        <input
          type="date"
          className="search-filter-date"
          value={filters.modifiedBefore ?? ""}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              modifiedBefore: event.target.value || null,
            })
          }
        />
      </label>

      <label className="search-filter-group">
        <span className="search-filter-legend">Sort</span>
        <select
          className="search-filter-select"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SearchSort)}
        >
          <option value="relevance">Relevance</option>
          <option value="modified">Modified date</option>
        </select>
      </label>
    </div>
  );
}

/**
 * Combine a free-text query with the structured filter object into the
 * inline-syntax string the sidecar parses. The free-text query is left
 * as-is; filter operators are appended.
 */
export function buildQueryString(query: string, filters: SearchFilters): string {
  const parts: string[] = [];
  const text = query.trim();
  if (text) parts.push(text);
  if (filters.kinds.length > 0) {
    parts.push(`kind:${filters.kinds.join(",")}`);
  }
  if (filters.mountId) {
    parts.push(`mount:${filters.mountId}`);
  }
  if (filters.modifiedAfter) {
    parts.push(`modified:>=${filters.modifiedAfter}`);
  }
  if (filters.modifiedBefore) {
    parts.push(`modified:<=${filters.modifiedBefore}`);
  }
  return parts.join(" ");
}

export function collectMountNodes(roots: ExplorerNode[]): ExplorerNode[] {
  return roots.filter((node) => node.kind === "mount");
}
