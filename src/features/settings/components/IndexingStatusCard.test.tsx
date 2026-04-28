import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type {
  IndexStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import { IndexingStatusCard } from "./IndexingStatusCard";

afterEach(() => cleanup());

function ready(data: IndexStatus): SidecarEnvelope<IndexStatus> {
  return { state: "ready", data };
}

describe("IndexingStatusCard", () => {
  it("shows a loading hint while the envelope is null", () => {
    render(<IndexingStatusCard envelope={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders queue depth, in-flight count, and indexed chunk count", () => {
    render(
      <IndexingStatusCard
        envelope={ready({ queueDepth: 4, inFlight: ["a", "b"], indexedChunks: 87 })}
      />
    );
    // Three stat cells in the same DOM all rendering numbers — query
    // by their dt label, then assert the dd next to each.
    const dts = screen.getAllByRole("term");
    const definitions = screen.getAllByRole("definition");
    const labelToValue: Record<string, string | null> = {};
    dts.forEach((dt, idx) => {
      labelToValue[dt.textContent ?? ""] = definitions[idx]?.textContent ?? null;
    });
    expect(labelToValue["Queue depth"]).toBe("4");
    expect(labelToValue["In flight"]).toBe("2");
    expect(labelToValue["Indexed chunks"]).toBe("87");
  });

  it("shows an idle hint when both queue and in-flight are empty", () => {
    render(
      <IndexingStatusCard
        envelope={ready({ queueDepth: 0, inFlight: [], indexedChunks: 12 })}
      />
    );
    expect(screen.getByText(/idle/i)).toBeInTheDocument();
  });

  it("pluralises the working hint correctly", () => {
    render(
      <IndexingStatusCard
        envelope={ready({ queueDepth: 1, inFlight: [], indexedChunks: 0 })}
      />
    );
    expect(screen.getByText(/1 pending node\b/i)).toBeInTheDocument();
  });

  it("surfaces the unavailable state with the supplied error", () => {
    render(
      <IndexingStatusCard
        envelope={
          { state: "unavailable", error: "queue.db locked" } as SidecarEnvelope<IndexStatus>
        }
      />
    );
    expect(screen.getByText(/queue\.db locked/i)).toBeInTheDocument();
  });
});
