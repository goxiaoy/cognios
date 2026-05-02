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

// ModelManagerStatus's LicenseAcceptanceModal calls setHfToken via
// the Tauri IPC bridge. JSDOM has no Tauri runtime; mock the module
// so the modal can complete its happy path without invoking
// `invoke()` directly.
const setHfTokenMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../lib/tauri/ipc", () => ({
  setHfToken: (token: string) => setHfTokenMock(token),
}));

// HuggingFace ↗ link uses Tauri's shell-open IPC. JSDOM has no
// Tauri runtime; capture the call so click tests can assert.
const openExternalMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (url: string) => openExternalMock(url),
}));

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
    nodeContent: vi.fn().mockResolvedValue({ state: "initialising" }),
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
            repo: "onnx-community/gte-multilingual-base",
            commit: "abc123def456",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
          captioner: {
            role: "captioner",
            state: "missing",
            repo: "unsloth/gemma-3n-E2B-it-GGUF",
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
    // Repo identity is visible without hover.
    expect(
      screen.getByText("onnx-community/gte-multilingual-base")
    ).toBeInTheDocument();
    expect(
      screen.getByText("unsloth/gemma-3n-E2B-it-GGUF")
    ).toBeInTheDocument();
  });

  it("renders rows in canonical order regardless of map insertion order", () => {
    // Sidecar ships keys in HashMap order — non-deterministic.
    // Inject the four roles in reverse-canonical order; the
    // component must still render Embedding → Reranker → OCR →
    // Captioner.
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          captioner: {
            role: "captioner",
            state: "missing",
            repo: "unsloth/gemma-3n-E2B-it-GGUF",
            licenseAccepted: false,
            requiresAcceptance: true,
          },
          ocr: {
            role: "ocr",
            state: "missing",
            repo: "PaddlePaddle/PP-OCRv4_mobile_det",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
          reranker: {
            role: "reranker",
            state: "missing",
            repo: "onnx-community/gte-multilingual-reranker-base",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
          embedding: {
            role: "embedding",
            state: "missing",
            repo: "onnx-community/gte-multilingual-base",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
      />
    );
    const labels = screen
      .getAllByText(/^(Embedding|Reranker|OCR|Captioner)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Embedding", "Reranker", "OCR", "Captioner"]);
  });

  it("appends unknown roles after the canonical four, alphabetically", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          "audio-zebra": {
            role: "audio-zebra",
            state: "missing",
            repo: "future/zebra-model",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
          embedding: {
            role: "embedding",
            state: "missing",
            repo: "onnx-community/gte-multilingual-base",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
          "audio-alpha": {
            role: "audio-alpha",
            state: "missing",
            repo: "future/alpha-model",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
      />
    );
    const labels = screen
      .getAllByText(/^(Embedding|audio-alpha|audio-zebra)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Embedding", "audio-alpha", "audio-zebra"]);
  });

  it("opens the HuggingFace tree URL when the ↗ link is clicked", async () => {
    openExternalMock.mockClear();
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "ready",
            repo: "onnx-community/gte-multilingual-base",
            commit: "abc123def456",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        })}
      />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /open onnx-community\/gte-multilingual-base on huggingface/i,
      })
    );
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith(
        "https://huggingface.co/onnx-community/gte-multilingual-base/tree/abc123def456"
      );
    });
  });

  it("falls back to the repo root URL when commit is the placeholder string", async () => {
    openExternalMock.mockClear();
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            repo: "onnx-community/gte-multilingual-base",
            commit: "<pinned>",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
      />
    );
    // The literal "<pinned>" placeholder must not leak into the UI.
    expect(screen.queryByText(/<pinned>/i)).toBeNull();
    expect(screen.queryByText(/^commit /)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /open onnx-community\/gte-multilingual-base on huggingface/i,
      })
    );
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledWith(
        "https://huggingface.co/onnx-community/gte-multilingual-base"
      );
    });
  });

  it("swallows shell-open errors gracefully (link click does not crash)", async () => {
    openExternalMock.mockClear();
    openExternalMock.mockRejectedValueOnce(new Error("shell-open denied"));
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "ready",
            repo: "onnx-community/gte-multilingual-base",
            commit: "abc123def456",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        })}
      />
    );
    const link = screen.getByRole("button", {
      name: /open onnx-community\/gte-multilingual-base on huggingface/i,
    });
    fireEvent.click(link);
    // Awaited promise rejection is swallowed; the row stays mounted
    // and the link is still clickable.
    await waitFor(() => {
      expect(openExternalMock).toHaveBeenCalledTimes(1);
    });
    expect(link).toBeInTheDocument();
  });

  it("hides the identity line entirely when repo is empty (legacy sidecar)", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "missing",
            repo: "",
            licenseAccepted: false,
            requiresAcceptance: false,
          },
        })}
      />
    );
    expect(screen.getByText("Embedding")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /huggingface/i })
    ).toBeNull();
  });

  it("renders the role's error message when present", () => {
    render(
      <ModelManagerStatus
        envelope={readyEnvelope({
          embedding: {
            role: "embedding",
            state: "error",
            repo: "onnx-community/gte-multilingual-base",
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
            repo: "onnx-community/gte-multilingual-base",
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
            repo: "onnx-community/gte-multilingual-base",
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

  it("blocks Download for license-gated captioner until license is accepted via modal", async () => {
    setHfTokenMock.mockClear();
    const client = makeClient();
    render(
      <ModelManagerStatus
        client={client}
        envelope={readyEnvelope({
          captioner: {
            role: "captioner",
            state: "missing",
            repo: "unsloth/gemma-3n-E2B-it-GGUF",
            licenseAccepted: false,
            requiresAcceptance: true,
          },
        })}
      />
    );
    // No Download until license is accepted.
    expect(screen.queryByRole("button", { name: /^Download$/i })).toBeNull();
    // Captioner license requires HF token — click goes through modal.
    fireEvent.click(screen.getByRole("button", { name: /accept license/i }));
    expect(client.acceptModelLicense).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/HuggingFace token/i), {
      target: { value: "hf_test_token" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /accept and save token/i })
    );
    await waitFor(() => {
      expect(setHfTokenMock).toHaveBeenCalledWith("hf_test_token");
    });
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
            repo: "onnx-community/gte-multilingual-base",
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
            repo: "onnx-community/gte-multilingual-base",
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
            repo: "onnx-community/gte-multilingual-base",
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
            repo: "onnx-community/gte-multilingual-base",
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
