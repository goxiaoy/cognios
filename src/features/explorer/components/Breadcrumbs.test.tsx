import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";

const node = (id: string, name: string) => ({
  id,
  parentId: null,
  name,
  kind: "folder" as const,
  state: "ready" as const,
  createdAt: "2026-04-26 00:00:00",
  modifiedAt: "2026-04-26 00:00:00",
  sizeBytes: 0,
  children: [],
});

describe("Breadcrumbs", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the path segments", () => {
    render(
      <Breadcrumbs nodes={[node("root", "workspace"), node("child", "docs"), node("leaf", "README.md")]} />
    );
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("renders nothing when the path is empty", () => {
    const { container } = render(<Breadcrumbs nodes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders separators between segments only", () => {
    const { container } = render(
      <Breadcrumbs nodes={[node("a", "a"), node("b", "b"), node("c", "c")]} />
    );
    const separators = container.querySelectorAll(".breadcrumb-separator");
    expect(separators.length).toBe(2);
  });

  it("collapses the middle of long paths", () => {
    render(
      <Breadcrumbs
        nodes={[
          node("root", "workspace"),
          node("docs", "docs"),
          node("cases", "cases"),
          node("incident", "incident"),
          node("photos", "photos"),
        ]}
      />
    );

    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.getByText("incident")).toBeInTheDocument();
    expect(screen.getByText("photos")).toBeInTheDocument();
    expect(screen.getByLabelText("Collapsed path: docs / cases")).toBeInTheDocument();
    expect(screen.queryByText("docs")).not.toBeInTheDocument();
    expect(screen.queryByText("cases")).not.toBeInTheDocument();
  });
});
