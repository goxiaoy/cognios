import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SearchSettings } from "../../../lib/contracts/search";
import { makeStubSearchClient } from "../../search/types/test-helpers";
import { FeaturesList } from "./FeaturesList";

afterEach(() => cleanup());

function baseSettings(): SearchSettings {
  return {
    version: 1,
    providers: {},
    features: {},
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  };
}

describe("FeaturesList", () => {
  it("renders configurable features before built-in mandatory features", () => {
    render(
      <FeaturesList
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
      />
    );

    expect(
      screen.getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))
    ).toEqual([
      "Image captioning",
      "Advanced OCR",
      "Chat",
      "Web search",
      "Semantic search",
      "Result reranking",
      "Image OCR",
    ]);
  });
});
