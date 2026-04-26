import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("renders the value in writable mode", () => {
    const onChange = vi.fn();
    const { container } = render(
      <MarkdownView onChange={onChange} readOnly={false} value="# Hello" />
    );

    const cmContent = container.querySelector(".cm-content");
    expect(cmContent?.textContent).toContain("# Hello");
  });

  it("renders the value in read-only mode", () => {
    const { container } = render(
      <MarkdownView readOnly={true} value="# Read only content" />
    );

    const cmContent = container.querySelector(".cm-content");
    expect(cmContent?.textContent).toContain("# Read only content");
  });

  it("does not invoke onChange when typing in read-only mode", () => {
    const onChange = vi.fn();
    const { container } = render(
      <MarkdownView onChange={onChange} readOnly={true} value="initial" />
    );

    const editable = container.querySelector('[contenteditable="true"]');
    if (editable) {
      fireEvent.input(editable, { target: { textContent: "edited" } });
    }

    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders empty value without crashing", () => {
    const { container } = render(<MarkdownView readOnly={true} value="" />);

    expect(container.querySelector(".cm-editor")).toBeInTheDocument();
  });
});
