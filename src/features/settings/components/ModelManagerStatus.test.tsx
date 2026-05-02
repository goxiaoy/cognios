import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type {
  ModelsStatus,
  SidecarEnvelope,
} from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { ModelManagerStatus } from "./ModelManagerStatus";

afterEach(() => cleanup());

function readyEnvelope(roles: ModelsStatus["roles"]): SidecarEnvelope<ModelsStatus> {
  return { state: "ready", data: { roles } };
}

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn(),
    indexStatus: vi.fn(),
    nodeIndexStatus: vi.fn(),
    modelsStatus: vi.fn(),
    acceptModelLicense: vi.fn().mockResolvedValue({
      state: "ready",
      data: { accepted: true, role: "captioner" },
    }),
    startModelDownload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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

  it("renders no action buttons without a client (read-only mode)", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        })}
      />
    );
    expect(
      screen.queryByRole("button", { name: /download/i })
    ).toBeNull();
  });

  it("renders a Download button for missing roles when a client is provided", async () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => {
      expect(client.startModelDownload).toHaveBeenCalledWith({
        role: "embedding",
      });
    });
  });

  it("blocks Download for license-gated roles until license is accepted", async () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          captioner: {
            role: "captioner",
            state: "missing",
            licenseAccepted: false,
            requiresAcceptance: true,
          },
        })}
      />
    );
    expect(screen.queryByRole("button", { name: /^Download$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /accept license/i }));
    await waitFor(() => {
      expect(client.acceptModelLicense).toHaveBeenCalledWith("captioner");
    });
  });

  it("surfaces a Retry button for errored roles", async () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "error",
            licenseAccepted: false,
            requiresAcceptance: false,
            error: "checksum mismatch",
          },
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(client.startModelDownload).toHaveBeenCalledWith({
        role: "embedding",
      });
    });
  });

  it("renders a determinate progress bar from a downloading event", () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
        progress={{
          embedding: {
            role: "embedding",
            state: "downloading",
            file: "onnx/model_int8.onnx",
            bytesDownloaded: 25_000_000,
            bytesTotal: 100_000_000,
          },
        }}
      />
    );
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("onnx/model_int8.onnx")).toBeInTheDocument();
  });

  it("renders the indeterminate variant when bytesTotal is unknown", () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
        progress={{
          embedding: {
            role: "embedding",
            state: "downloading",
            bytesDownloaded: 0,
            bytesTotal: null,
          },
        }}
      />
    );
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it("hides the Download button while a download is in flight for that role", () => {
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
        progress={{
          embedding: {
            role: "embedding",
            state: "downloading",
            bytesDownloaded: 1024,
            bytesTotal: 100_000,
          },
        }}
      />
    );
    expect(screen.queryByRole("button", { name: /^Download$/i })).toBeNull();
  });
});
