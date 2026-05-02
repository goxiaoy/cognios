import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { LicenseAcceptanceModal } from "./LicenseAcceptanceModal";
import type { SearchClient } from "../../search/types/search";

afterEach(() => cleanup());

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
    startModelDownload: vi.fn(),
    nodeContent: vi.fn(),
    settings: vi.fn().mockResolvedValue({ state: "initialising" }),
    updateSettings: vi.fn().mockResolvedValue({ state: "initialising" }),
    restartSidecar: vi.fn().mockResolvedValue(undefined),
    readSettingsFallback: vi.fn().mockResolvedValue({
      version: 1,
      providers: {},
      features: {},
      cloudConsentAcked: [],
      firstRunSkipped: false,
      needsRestart: false,
    }),
    setProviderSecret: vi.fn().mockResolvedValue(undefined),
    hasProviderSecret: vi.fn().mockResolvedValue(false),
    deleteProviderSecret: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LicenseAcceptanceModal", () => {
  it("focuses the token input on mount and renders the Gemma copy", () => {
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={makeClient()}
        onAccepted={vi.fn()}
        onCancel={vi.fn()}
        setHfToken={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByLabelText(/HuggingFace token/i)).toHaveFocus();
    expect(screen.getByText(/Gemma Terms of Use/i)).toBeInTheDocument();
  });

  it("requires a non-empty token before sending", async () => {
    const setHfToken = vi.fn().mockResolvedValue(undefined);
    const client = makeClient();
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={client}
        onAccepted={vi.fn()}
        onCancel={vi.fn()}
        setHfToken={setHfToken}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /accept and save token/i })
    );
    await waitFor(() => {
      expect(screen.getByText(/HuggingFace token is required/i))
        .toBeInTheDocument();
    });
    expect(setHfToken).not.toHaveBeenCalled();
    expect(client.acceptModelLicense).not.toHaveBeenCalled();
  });

  it("saves the token and accepts the license on the happy path", async () => {
    const setHfToken = vi.fn().mockResolvedValue(undefined);
    const client = makeClient();
    const onAccepted = vi.fn();
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={client}
        onAccepted={onAccepted}
        onCancel={vi.fn()}
        setHfToken={setHfToken}
      />
    );
    fireEvent.change(screen.getByLabelText(/HuggingFace token/i), {
      target: { value: "hf_test123" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /accept and save token/i })
    );
    await waitFor(() => {
      expect(setHfToken).toHaveBeenCalledWith("hf_test123");
    });
    await waitFor(() => {
      expect(client.acceptModelLicense).toHaveBeenCalledWith("captioner");
    });
    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalled();
    });
  });

  it("does NOT call acceptModelLicense if the keychain write fails", async () => {
    const setHfToken = vi.fn().mockRejectedValue(new Error("keyring busy"));
    const client = makeClient();
    const onAccepted = vi.fn();
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={client}
        onAccepted={onAccepted}
        onCancel={vi.fn()}
        setHfToken={setHfToken}
      />
    );
    fireEvent.change(screen.getByLabelText(/HuggingFace token/i), {
      target: { value: "hf_test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /accept and save token/i })
    );
    await waitFor(() => {
      expect(screen.getByText(/keyring busy/i)).toBeInTheDocument();
    });
    expect(client.acceptModelLicense).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("surfaces a non-ready license envelope as an error", async () => {
    const client = makeClient({
      acceptModelLicense: vi.fn().mockResolvedValue({
        state: "unavailable",
        error: "sidecar offline",
      }),
    });
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={client}
        onAccepted={vi.fn()}
        onCancel={vi.fn()}
        setHfToken={vi.fn().mockResolvedValue(undefined)}
      />
    );
    fireEvent.change(screen.getByLabelText(/HuggingFace token/i), {
      target: { value: "hf_test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /accept and save token/i })
    );
    await waitFor(() => {
      expect(screen.getByText(/sidecar offline/i)).toBeInTheDocument();
    });
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <LicenseAcceptanceModal
        role="captioner"
        client={makeClient()}
        onAccepted={vi.fn()}
        onCancel={onCancel}
        setHfToken={vi.fn()}
      />
    );
    // The dialog has two cancellation affordances: an X icon in the
    // header (aria-label="Cancel") and a "Cancel" button in the
    // footer. Test the footer button specifically.
    const secondary = container.querySelector(".license-modal-secondary")!;
    fireEvent.click(secondary);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape is pressed in the input", () => {
    const onCancel = vi.fn();
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={makeClient()}
        onAccepted={vi.fn()}
        onCancel={onCancel}
        setHfToken={vi.fn()}
      />
    );
    fireEvent.keyDown(screen.getByLabelText(/HuggingFace token/i), {
      key: "Escape",
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("submits via Enter from the token input", async () => {
    const setHfToken = vi.fn().mockResolvedValue(undefined);
    const client = makeClient();
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={client}
        onAccepted={vi.fn()}
        onCancel={vi.fn()}
        setHfToken={setHfToken}
      />
    );
    const input = screen.getByLabelText(/HuggingFace token/i);
    fireEvent.change(input, { target: { value: "hf_xxx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(setHfToken).toHaveBeenCalledWith("hf_xxx");
    });
  });

  it("masks the token input as a password field", () => {
    render(
      <LicenseAcceptanceModal
        role="captioner"
        client={makeClient()}
        onAccepted={vi.fn()}
        onCancel={vi.fn()}
        setHfToken={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/HuggingFace token/i)).toHaveAttribute(
      "type",
      "password"
    );
  });
});
