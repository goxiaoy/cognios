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
import { FEATURE_CATALOG } from "../data/providerPresets";
import { FeatureRow } from "./FeatureRow";

afterEach(() => cleanup());

const SEMANTIC = FEATURE_CATALOG.find((m) => m.featureId === "semantic-search")!;
const RERANKING = FEATURE_CATALOG.find((m) => m.featureId === "result-reranking")!;
const OCR = FEATURE_CATALOG.find((m) => m.featureId === "image-ocr")!;

// Synthetic optional/non-coming-soon feature for toggle-path tests —
// every catalog entry is currently either mandatory or coming-soon, so
// the toggle render path is exercised against a stand-in.
const OPTIONAL_TEST_FEATURE = {
  featureId: "result-reranking",
  displayName: "Result reranking (test)",
  description: "test only",
  capability: "reranking" as const,
  mandatory: false,
  comingSoon: false,
};

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
      "result-reranking": { enabled: false, providerId: null },
      "image-ocr": { enabled: false, providerId: null },
      "image-captioning": { enabled: false, providerId: null },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  };
}

describe("FeatureRow", () => {
  it("renders a Required badge for mandatory features (no toggle)", () => {
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders an enable toggle for optional features", () => {
    render(
      <FeatureRow
        meta={OPTIONAL_TEST_FEATURE}
        config={{ enabled: false, providerId: null }}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("renders a Required badge for the result-reranking feature", () => {
    expect(RERANKING.mandatory).toBe(true);
    render(
      <FeatureRow
        meta={RERANKING}
        config={{ enabled: true, providerId: "local-gte-reranker" }}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders coming-soon hint for Phase-2 features and disables interaction", () => {
    // No catalog entry is comingSoon in v1 — every feature ships a
    // working extractor path. Use a synthetic meta to exercise the
    // render branch so the mechanism stays covered for future Phase-2
    // additions.
    const phase2 = {
      featureId: "phase2-test",
      displayName: "Phase 2 test",
      description: "test only",
      capability: "vision" as const,
      mandatory: false,
      comingSoon: true,
    };
    render(
      <FeatureRow
        meta={phase2}
        config={undefined}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("filters provider picker to compatible providers only", () => {
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );
    // Picker shows local-gte + openai (both declare embedding); does
    // NOT show qwen-dashscope (vision only) or local-gemma.
    const picker = screen.getByRole("combobox");
    const options = Array.from(picker.querySelectorAll("option")).map(
      (o) => o.textContent ?? ""
    );
    expect(options).toContain("Local GTE");
    expect(options.some((t) => t.startsWith("OpenAI"))).toBe(true);
    expect(options.some((t) => t.startsWith("Qwen"))).toBe(false);
    expect(options.some((t) => t.startsWith("Local Gemma"))).toBe(false);
  });

  it("calls updateSettings with the new provider when picker changes", async () => {
    const onSettingsChange = vi.fn();
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    // Pre-ack OpenAI's consent so the picker change doesn't get
    // intercepted by the cloud-egress dialog (covered by its own
    // dedicated tests).
    const settings = baseSettings();
    settings.cloudConsentAcked = ["openai"];
    render(
      <FeatureRow
        meta={SEMANTIC}
        config={{ enabled: true, providerId: "local-gte" }}
        settings={settings}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={onSettingsChange}
      />
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    const arg = updateSettings.mock.calls[0][0];
    expect(arg.features["semantic-search"].providerId).toBe("openai");
  });

  it("toggling an optional feature flips enabled in the PUT payload", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <FeatureRow
        meta={OPTIONAL_TEST_FEATURE}
        config={{ enabled: false, providerId: null }}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    const arg = updateSettings.mock.calls[0][0];
    expect(arg.features["result-reranking"].enabled).toBe(true);
  });
});
