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

/** Open the FeatureRow's chooser modal, pick the provider whose name
 * matches ``radioPattern``, and click "Use this provider" — the
 * post-Unit-13 replacement for ``fireEvent.change(combobox)``. */
async function selectProviderViaChooser(radioPattern: RegExp) {
  fireEvent.click(
    screen.getByRole("button", {
      name: /(change|choose) provider for semantic search/i,
    })
  );
  fireEvent.click(screen.getByRole("radio", { name: radioPattern }));
  fireEvent.click(
    await screen.findByRole("button", { name: /use this provider/i })
  );
}

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
        client={makeStubSearchClient({
          updateSettings,
          hasProviderSecret: vi.fn().mockResolvedValue(true),
        })}
        onSettingsChange={vi.fn()}
      />
    );
    await selectProviderViaChooser(/openai/i);
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
        client={makeStubSearchClient({
          updateSettings,
          hasProviderSecret: vi.fn().mockResolvedValue(true),
        })}
        onSettingsChange={vi.fn()}
      />
    );
    await selectProviderViaChooser(/openai/i);
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
        client={makeStubSearchClient({
          updateSettings,
          hasProviderSecret: vi.fn().mockResolvedValue(true),
        })}
        onSettingsChange={vi.fn()}
      />
    );
    await selectProviderViaChooser(/openai/i);
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
        client={makeStubSearchClient({
          updateSettings,
          hasProviderSecret: vi.fn().mockResolvedValue(true),
        })}
        onSettingsChange={vi.fn()}
      />
    );
    await selectProviderViaChooser(/openai/i);
    // The chooser closes once we confirm; only the consent dialog's
    // Cancel button is on screen now.
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
    // Start unbound so the chooser's "Use this provider" button is
    // enabled when we pick local-gte (the only embedding-capable
    // local preset). Picking the same provider that's already bound
    // is a no-op and the confirm button stays disabled.
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: null }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    await selectProviderViaChooser(/^GTE/i);
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    expect(screen.queryByText(/Send data to/i)).toBeNull();
  });
});
