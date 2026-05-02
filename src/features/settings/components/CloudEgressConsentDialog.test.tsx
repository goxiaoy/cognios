import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { SearchSettings } from "../../../lib/contracts/search";
import { makeStubSearchClient } from "../../search/types/test-helpers";
import { FEATURE_CATALOG, presetById } from "../data/providerPresets";
import { CloudEgressConsentDialog } from "./CloudEgressConsentDialog";
import { FeatureRow } from "./FeatureRow";

afterEach(() => cleanup());

const SEMANTIC = FEATURE_CATALOG.find((m) => m.featureId === "semantic-search")!;
const OPENAI = presetById("openai")!;

function baseSettings(): SearchSettings {
  return {
    version: 1,
    providers: {
      "local-gte": {
        providerId: "local-gte",
        enabled: true,
        apiKeyRef: null,
        baseUrl: null,
        modelPerCapability: {},
      },
    },
    features: {
      "semantic-search": { enabled: true, providerId: "local-gte" },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  };
}

describe("CloudEgressConsentDialog", () => {
  it("renders the provider name in the dialog title and CTA", () => {
    render(
      <CloudEgressConsentDialog
        preset={OPENAI}
        onAccept={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Send data to OpenAI/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /enable openai/i })
    ).toBeInTheDocument();
  });

  it("calls onAccept and onCancel for the respective buttons", () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    render(
      <CloudEgressConsentDialog
        preset={OPENAI}
        onAccept={onAccept}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /enable openai/i }));
    expect(onAccept).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("Cloud-egress consent gate (FeatureRow integration)", () => {
  it("blocks the PUT and shows the dialog when picking a cloud provider for the first time", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "openai" },
    });
    // Dialog should appear; PUT must NOT have fired yet.
    await waitFor(() => {
      expect(
        screen.getByText(/Send data to OpenAI/i)
      ).toBeInTheDocument();
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("after acceptance, PUTs both the binding AND the consent ack atomically", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "openai" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /enable openai/i })
    );
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    const arg = updateSettings.mock.calls[0][0];
    expect(arg.features["semantic-search"].providerId).toBe("openai");
    expect(arg.cloudConsentAcked).toEqual(["openai"]);
  });

  it("does NOT show the dialog when provider is already in cloudConsentAcked", async () => {
    const settings = baseSettings();
    settings.cloudConsentAcked = ["openai"];
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: settings,
    });
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={settings}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "openai" },
    });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Send data to OpenAI/i)).toBeNull();
  });

  it("Cancel does not commit the provider change", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "openai" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /^cancel$/i })
    );
    await waitFor(() => {
      expect(screen.queryByText(/Send data to OpenAI/i)).toBeNull();
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("does not show dialog when picking a local provider", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    // Change to local-gte (already selected, but pretend) — no dialog.
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "local-gte" },
    });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Send data to/i)).toBeNull();
  });
});
