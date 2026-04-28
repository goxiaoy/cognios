import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SearchResult } from "../types/search";
import { SearchResultRow } from "./SearchResultRow";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    nodeId: "node-id",
    kind: "note",
    name: "OAuth.md",
    score: 1.2,
    snippet: "PKCE replaces the implicit flow.",
    matchedIn: "content",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("SearchResultRow", () => {
  it("renders name, kind label, and snippet text", () => {
    render(
      <SearchResultRow
        result={makeResult()}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    expect(screen.getByText("OAuth.md")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("PKCE replaces the implicit flow.")).toBeInTheDocument();
  });

  it("invokes onActivate when clicked", () => {
    const onActivate = vi.fn();
    render(
      <SearchResultRow
        result={makeResult()}
        active={false}
        rowId="row-0"
        onActivate={onActivate}
      />
    );
    fireEvent.click(screen.getByRole("option"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("invokes onHover when the mouse enters the row", () => {
    const onHover = vi.fn();
    render(
      <SearchResultRow
        result={makeResult()}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
        onHover={onHover}
      />
    );
    fireEvent.mouseEnter(screen.getByRole("option"));
    expect(onHover).toHaveBeenCalledTimes(1);
  });

  it("sets aria-selected=true when active", () => {
    const { container } = render(
      <SearchResultRow
        result={makeResult()}
        active={true}
        rowId="row-1"
        onActivate={vi.fn()}
      />
    );
    const row = container.querySelector('[role="option"]');
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("id", "row-1");
  });

  it("renders snippet content as text only — never as HTML", () => {
    /** SEC-FINDING-002 carry-forward: snippets contain untrusted text
     * (OCR output, AI captions, URL bodies) and MUST render via text
     * nodes only. A snippet containing tag-like characters must
     * appear verbatim, not as parsed markup. */
    const evil = "<script>alert(1)</script><img src=x>";
    render(
      <SearchResultRow
        result={makeResult({ snippet: evil })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    // The literal string is in the DOM as text content.
    expect(screen.getByText(evil)).toBeInTheDocument();
    // Critically, no <script> or <img> element from the snippet was
    // injected into the document.
    const injected = document.querySelector(".search-result-snippet script, .search-result-snippet img");
    expect(injected).toBeNull();
  });

  it("omits the snippet element when snippet is empty", () => {
    const { container } = render(
      <SearchResultRow
        result={makeResult({ snippet: "" })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    expect(container.querySelector(".search-result-snippet")).toBeNull();
  });

  it("falls back to the raw kind string for unknown kinds", () => {
    render(
      <SearchResultRow
        result={makeResult({ kind: "exotic" })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    expect(screen.getByText("exotic")).toBeInTheDocument();
  });

  it("renders <mark> spans at the supplied match offsets", () => {
    const { container } = render(
      <SearchResultRow
        result={makeResult({
          snippet: "PKCE replaces the implicit flow with PKCE",
          matchOffsets: [
            [0, 4],
            [37, 41],
          ],
        })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    const marks = container.querySelectorAll(".search-result-snippet mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("PKCE");
    expect(marks[1].textContent).toBe("PKCE");
    // The full snippet still renders end-to-end as the row's text.
    expect(
      container.querySelector(".search-result-snippet")?.textContent
    ).toBe("PKCE replaces the implicit flow with PKCE");
  });

  it("renders without <mark> elements when offsets are absent", () => {
    const { container } = render(
      <SearchResultRow
        result={makeResult({ snippet: "hello world" })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    expect(
      container.querySelectorAll(".search-result-snippet mark")
    ).toHaveLength(0);
  });

  it("treats offsets as text-only — angle brackets in the matched run never spawn DOM", () => {
    /** Carry-forward of SEC-FINDING-002 to the highlighted path: even
     * when an offset wraps a run of "<script>" characters, those
     * become a `<mark>` element's text content, not parsed HTML. */
    const snippet = "before <script>evil()</script> after";
    const { container } = render(
      <SearchResultRow
        result={makeResult({
          snippet,
          matchOffsets: [[7, 30]],
        })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    const marks = container.querySelectorAll(".search-result-snippet mark");
    expect(marks).toHaveLength(1);
    // The mark's text node literally contains the whole script-shaped
    // substring; no <script> or </script> child element exists.
    expect(marks[0].textContent).toBe("<script>evil()</script>");
    expect(marks[0].querySelector("script")).toBeNull();
  });

  it("ignores out-of-range and overlapping offsets defensively", () => {
    const { container } = render(
      <SearchResultRow
        result={makeResult({
          snippet: "abcdef",
          matchOffsets: [
            [0, 3],
            [1, 2], // overlaps prior; must be skipped
            [10, 20], // out of range; clamped to no-op
          ],
        })}
        active={false}
        rowId="row-0"
        onActivate={vi.fn()}
      />
    );
    const marks = container.querySelectorAll(".search-result-snippet mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("abc");
    expect(
      container.querySelector(".search-result-snippet")?.textContent
    ).toBe("abcdef");
  });
});
