import type { ExplorerNode } from "../../explorer/types/explorer";
import type { SearchSort } from "../../../lib/contracts/search";

export type KindFilter =
  | "note"
  | "file"
  | "url"
  | "folder"
  | "mount";

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
 * Filter + sort controls. Renders a stack of "rows", each with a
 * sentence-case label column on the left and the control(s) on the
 * right. The visual aesthetic is intentionally muted (Linear-style) —
 * subtle backgrounds for chips, custom-styled selects/dates that
 * match the chip shape, no SHOUTY uppercase legends. The same
 * component services the Cmd+K palette filter panel and any future
 * filter-rich surface.
 *
 * Filters serialise into the inline-syntax string the sidecar parses
 * (``kind:note,file mount:<uuid> modified:>=YYYY-MM-DD``) via
 * :func:`buildQueryString`. ``sort`` is a separate IPC field.
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
    <div
      className="search-filter-bar"
      role="group"
      aria-label="Search filters"
    >
      <FilterRow label="Kind">
        <div className="search-filter-chips" role="group" aria-label="Kind">
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
      </FilterRow>

      <FilterRow label="Mount">
        <SelectControl
          label="Mount"
          value={filters.mountId ?? ""}
          onChange={(value) =>
            onFiltersChange({ ...filters, mountId: value || null })
          }
          options={[
            { value: "", label: "Any mount" },
            ...mounts.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      </FilterRow>

      <FilterRow label="Modified">
        <div className="search-filter-date-pair">
          <DateControl
            ariaLabel="Modified after"
            value={filters.modifiedAfter ?? ""}
            onChange={(value) =>
              onFiltersChange({ ...filters, modifiedAfter: value || null })
            }
          />
          <span className="search-filter-date-sep" aria-hidden="true">
            →
          </span>
          <DateControl
            ariaLabel="Modified before"
            value={filters.modifiedBefore ?? ""}
            onChange={(value) =>
              onFiltersChange({ ...filters, modifiedBefore: value || null })
            }
          />
        </div>
      </FilterRow>

      <FilterRow label="Sort">
        <SelectControl
          label="Sort"
          value={sort}
          onChange={(value) => onSortChange(value as SearchSort)}
          options={[
            { value: "relevance", label: "Relevance" },
            { value: "modified", label: "Modified date" },
          ]}
        />
      </FilterRow>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="search-filter-row">
      <span className="search-filter-row-label">{label}</span>
      <div className="search-filter-row-control">{children}</div>
    </div>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
}) {
  return (
    <span className="search-filter-select-wrap">
      <select
        className="search-filter-select"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <span className="search-filter-select-caret" aria-hidden="true">
        ▾
      </span>
    </span>
  );
}

function DateControl({
  ariaLabel,
  value,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <input
      type="date"
      className="search-filter-date"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
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
