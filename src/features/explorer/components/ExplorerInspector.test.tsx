import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExplorerInspector } from "./ExplorerInspector";

describe("ExplorerInspector", () => {
  it("shows url indexing state in single-node mode", () => {
    render(
      <ExplorerInspector
        node={{
          id: "url-1",
          parentId: null,
          name: "Example",
          kind: "url",
          state: "indexed",
          createdAt: "2026-04-13 00:00:00",
          modifiedAt: "2026-04-13 00:00:00",
          sizeBytes: 128,
          children: []
        }}
        selectedArtifacts={[]}
        selectionCount={0}
      />
    );

    expect(screen.getByText("indexed")).toBeInTheDocument();
    expect(screen.getByText(/WEB LINK/i)).toBeInTheDocument();
  });

  it("shows aggregate metadata during multi-select", () => {
    render(
      <ExplorerInspector
        node={null}
        selectedArtifacts={[
          {
            id: "a",
            parentId: "root",
            name: "alpha.png",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-13 00:00:00",
            modifiedAt: "2026-04-13 00:00:00",
            sizeBytes: 32,
            children: []
          },
          {
            id: "b",
            parentId: "root",
            name: "beta.png",
            kind: "file",
            state: "ready",
            createdAt: "2026-04-13 00:00:00",
            modifiedAt: "2026-04-13 00:00:00",
            sizeBytes: 64,
            children: []
          }
        ]}
        selectionCount={2}
      />
    );

    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.getByText("96 B")).toBeInTheDocument();
  });
});
