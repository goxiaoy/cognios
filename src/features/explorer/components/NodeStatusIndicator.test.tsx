import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { NodeStatusView } from "../../../lib/contracts/nodeStatus";
import { NodeStatusIndicator } from "./NodeStatusIndicator";

function status(overrides: Partial<NodeStatusView> = {}): NodeStatusView {
  return {
    nodeId: "node-1",
    overall: "running",
    primaryStageId: "voice.transcribe",
    updatedAt: "2026-06-06 00:00:00",
    stages: [
      {
        id: "voice.transcribe",
        label: "Transcribing",
        state: "running",
        importance: "required",
        message: "Transcribing",
        attempt: 0,
        updatedAt: "2026-06-06 00:00:00",
      },
    ],
    ...overrides,
  };
}

describe("NodeStatusIndicator", () => {
  it("uses the primary running stage as the row label", () => {
    render(
      <NodeStatusIndicator
        fallbackKind="note"
        fallbackState="ready"
        status={status()}
      />
    );

    expect(screen.getByLabelText("Transcribing")).toBeInTheDocument();
  });

  it("surfaces partial status for optional failures", () => {
    render(
      <NodeStatusIndicator
        fallbackKind="note"
        fallbackState="indexed"
        status={status({
          overall: "partial",
          primaryStageId: "voice.summarize",
          stages: [
            {
              id: "voice.summarize",
              label: "Summarizing",
              state: "failed",
              importance: "optional",
              error: { message: "Provider unavailable", retryable: true },
              attempt: 1,
              updatedAt: "2026-06-06 00:00:00",
            },
          ],
        })}
      />
    );

    expect(screen.getByLabelText("Partially ready")).toBeInTheDocument();
  });
});
