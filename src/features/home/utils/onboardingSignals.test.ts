import { describe, expect, it } from "vitest";

import type { SearchSettings } from "../../../lib/contracts/search";
import type { ExplorerNode } from "../../explorer/types/explorer";
import {
  advancedOcrPromptFingerprint,
  chatPromptFingerprint,
  hasAdvancedOcrCandidate,
  isWorkspaceEmpty,
  shouldPromptForAdvancedOcr,
  shouldPromptForChatProvider,
} from "./onboardingSignals";

function node(overrides: Partial<ExplorerNode> = {}): ExplorerNode {
  return {
    id: "node-1",
    parentId: null,
    name: "note.md",
    kind: "note",
    state: "ready",
    createdAt: "2026-05-17 00:00:00",
    modifiedAt: "2026-05-17 00:00:00",
    sizeBytes: 0,
    children: [],
    ...overrides,
  };
}

function settings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    version: 1,
    providers: {
      "local-ollama": {
        providerId: "local-ollama",
        enabled: true,
        baseUrl: "http://127.0.0.1:11434",
        modelPerCapability: {},
      },
      "local-paddleocr-advanced": {
        providerId: "local-paddleocr-advanced",
        enabled: true,
        modelPerCapability: {},
      },
    },
    features: {
      llm: { enabled: true, providerId: "local-ollama" },
      "advanced-ocr": { enabled: false, providerId: null },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
    ...overrides,
  };
}

describe("onboardingSignals", () => {
  it("treats only a rootless explorer snapshot as workspace-empty", () => {
    expect(isWorkspaceEmpty([])).toBe(true);
    expect(isWorkspaceEmpty([node()])).toBe(false);
  });

  it("detects image and PDF nodes recursively for Advanced OCR prompts", () => {
    const tree = [
      node({
        id: "mount",
        kind: "mount",
        name: "workspace",
        children: [
          node({
            id: "folder",
            parentId: "mount",
            kind: "folder",
            name: "docs",
            children: [
              node({
                id: "pdf-1",
                parentId: "folder",
                kind: "file",
                name: "invoice.pdf",
              }),
            ],
          }),
        ],
      }),
    ];

    expect(hasAdvancedOcrCandidate(tree)).toBe(true);
    expect(shouldPromptForAdvancedOcr(tree, settings())).toBe(true);
  });

  it("does not prompt for Advanced OCR when the feature is already usable", () => {
    const image = [node({ id: "img-1", kind: "file", name: "scan.png" })];
    const configured = settings({
      features: {
        llm: { enabled: true, providerId: "local-ollama" },
        "advanced-ocr": {
          enabled: true,
          providerId: "local-paddleocr-advanced",
        },
      },
    });

    expect(shouldPromptForAdvancedOcr(image, configured)).toBe(false);
  });

  it("prompts for Chat when the feature is unbound or bound provider is disabled", () => {
    expect(
      shouldPromptForChatProvider(
        settings({ features: { llm: { enabled: false, providerId: null } } })
      )
    ).toBe(true);
    expect(
      shouldPromptForChatProvider(
        settings({
          providers: {
            "local-ollama": {
              providerId: "local-ollama",
              enabled: false,
              baseUrl: "http://127.0.0.1:11434",
              modelPerCapability: {},
            },
          },
        })
      )
    ).toBe(true);
    expect(shouldPromptForChatProvider(settings())).toBe(false);
  });

  it("fingerprints prompts by relevant provider and content state", () => {
    const first = [node({ id: "pdf-1", kind: "file", name: "a.pdf" })];
    const second = [node({ id: "pdf-2", kind: "file", name: "b.pdf" })];

    expect(advancedOcrPromptFingerprint(first, settings())).not.toEqual(
      advancedOcrPromptFingerprint(second, settings())
    );
    expect(chatPromptFingerprint(settings())).toContain("local-ollama");
  });
});
