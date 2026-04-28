import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type {
  ModelsStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import { ModelManagerStatus } from "./ModelManagerStatus";

afterEach(() => cleanup());

function readyEnvelope(roles: ModelsStatus["roles"]): SidecarEnvelope<ModelsStatus> {
  return { state: "ready", data: { roles } };
}

describe("ModelManagerStatus", () => {
  it("shows a loading hint while the envelope is null", () => {
    render(<ModelManagerStatus envelope={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("surfaces the initialising state from the sidecar envelope", () => {
    render(
      <ModelManagerStatus
        envelope={{ state: "initialising" } as SidecarEnvelope<ModelsStatus>}
      />
    );
    expect(screen.getByText(/starting up/i)).toBeInTheDocument();
  });

  it("surfaces the unavailable state with the supplied error", () => {
    render(
      <ModelManagerStatus
        envelope={{
          state: "unavailable",
          error: "supervisor crashed",
        } as SidecarEnvelope<ModelsStatus>}
      />
    );
    expect(screen.getByText(/supervisor crashed/i)).toBeInTheDocument();
  });

  it("renders one row per role with the right state badge", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "ready",
            commit: "abc123def456",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
          captioner: {
            role: "captioner",
            state: "missing",
            licenseAccepted: false,
            requiresAcceptance: true,
          },
        })}
      />
    );
    expect(screen.getByText("Embedding")).toBeInTheDocument();
    expect(screen.getByText("Captioner")).toBeInTheDocument();
    expect(screen.getByText(/^Ready$/i)).toBeInTheDocument();
    expect(screen.getByText(/Not downloaded/i)).toBeInTheDocument();
    // License pending is shown for the captioner because it requires
    // acceptance and hasn't been accepted yet.
    expect(screen.getByText(/License pending/i)).toBeInTheDocument();
    // Truncated commit hash is visible.
    expect(screen.getByText(/^commit abc123de$/)).toBeInTheDocument();
  });

  it("renders the role's error message when present", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "error",
            licenseAccepted: false,
            requiresAcceptance: false,
            error: "checksum mismatch on model_int8.onnx",
          },
        })}
      />
    );
    expect(screen.getByText(/checksum mismatch/i)).toBeInTheDocument();
  });
});
