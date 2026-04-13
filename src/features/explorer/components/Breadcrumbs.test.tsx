import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";

describe("Breadcrumbs", () => {
  it("renders a path and lets the user reselect ancestors", () => {
    const onSelect = vi.fn();

    render(
      <Breadcrumbs
        nodes={[
          {
            id: "root",
            parentId: null,
            name: "Root",
            kind: "folder",
            state: "ready",
            children: []
          },
          {
            id: "child",
            parentId: "root",
            name: "Child",
            kind: "folder",
            state: "ready",
            children: []
          }
        ]}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Root/i }));
    expect(onSelect).toHaveBeenCalledWith("root");
    expect(screen.getByText("Child")).toBeInTheDocument();
  });
});
