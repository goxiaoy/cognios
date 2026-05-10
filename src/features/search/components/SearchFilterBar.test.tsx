import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  buildQueryString,
  collectMountNodes,
  EMPTY_FILTERS,
  SearchFilterBar,
  type SearchFilters,
} from "./SearchFilterBar";
import type { ExplorerNode } from "../../explorer/types/explorer";

const mountNode: ExplorerNode = {
  id: "11111111-1111-1111-1111-111111111111",
  parentId: null,
  kind: "mount",
  name: "Notes",
  state: "ready",
  createdAt: "2026-04-01T00:00:00Z",
  modifiedAt: "2026-04-01T00:00:00Z",
  sizeBytes: 0,
  children: [],
};

describe("buildQueryString", () => {
  it("returns the bare query when no filters are applied", () => {
    expect(buildQueryString("oauth", EMPTY_FILTERS)).toBe("oauth");
  });

  it("emits kind: with comma-separated values", () => {
    const filters: SearchFilters = { ...EMPTY_FILTERS, kinds: ["note", "url"] };
    expect(buildQueryString("oauth", filters)).toBe("oauth kind:note,url");
  });

  it("emits modified:>= and modified:<= when both bounds present", () => {
    const filters: SearchFilters = {
      ...EMPTY_FILTERS,
      modifiedAfter: "2026-01-01",
      modifiedBefore: "2026-04-01",
    };
    expect(buildQueryString("oauth", filters)).toBe(
      "oauth modified:>=2026-01-01 modified:<=2026-04-01"
    );
  });

  it("emits a mount filter when one is selected", () => {
    const filters: SearchFilters = {
      ...EMPTY_FILTERS,
      mountId: "11111111-1111-1111-1111-111111111111",
    };
    expect(buildQueryString("", filters)).toBe(
      "mount:11111111-1111-1111-1111-111111111111"
    );
  });

  it("trims surrounding whitespace from the free-text query", () => {
    expect(buildQueryString("   oauth   ", EMPTY_FILTERS)).toBe("oauth");
  });
});

describe("collectMountNodes", () => {
  it("returns only mount-kind roots", () => {
    const folder: ExplorerNode = { ...mountNode, kind: "folder", id: "f" };
    expect(collectMountNodes([mountNode, folder])).toEqual([mountNode]);
  });
});

afterEach(() => cleanup());

describe("SearchFilterBar", () => {
  function renderBar(initialFilters: SearchFilters = EMPTY_FILTERS) {
    const onFiltersChange = vi.fn();
    const onSortChange = vi.fn();
    render(
      <SearchFilterBar
        filters={initialFilters}
        sort="relevance"
        mounts={[mountNode]}
        onFiltersChange={onFiltersChange}
        onSortChange={onSortChange}
      />
    );
    return { onFiltersChange, onSortChange };
  }

  it("toggles a kind chip and reports the new filter set", () => {
    const { onFiltersChange } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: /^Notes$/ }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      kinds: ["note"],
    });
  });

  it("removes a kind chip when clicked while active", () => {
    const { onFiltersChange } = renderBar({ ...EMPTY_FILTERS, kinds: ["note"] });
    fireEvent.click(screen.getByRole("button", { name: /^Notes$/ }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      kinds: [],
    });
  });

  it("emits the selected mount id from the dropdown", () => {
    const { onFiltersChange } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: /mount: any mount/i }));
    fireEvent.click(screen.getByRole("option", { name: "Notes" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      mountId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("emits the chosen sort mode", () => {
    const { onSortChange } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: /sort: relevance/i }));
    fireEvent.click(screen.getByRole("option", { name: "Modified date" }));
    expect(onSortChange).toHaveBeenCalledWith("modified");
  });

  it("emits a selected modified date from the calendar", () => {
    const { onFiltersChange } = renderBar({
      ...EMPTY_FILTERS,
      modifiedAfter: "2026-03-10",
    });

    fireEvent.click(screen.getByRole("button", { name: /modified after: 2026-03-10/i }));
    fireEvent.click(screen.getByRole("button", { name: "2026-03-15" }));

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      modifiedAfter: "2026-03-15",
    });
  });
});
