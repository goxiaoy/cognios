import { vi } from "vitest";

import type { SearchClient } from "./search";

/**
 * Returns a SearchClient where every method is a `vi.fn()` that
 * resolves to a benign default. Tests pass `overrides` to replace
 * specific methods; the defaults keep TypeScript happy without
 * forcing every test file to enumerate every method on the
 * interface every time we add one.
 */
export function makeStubSearchClient(
  overrides: Partial<SearchClient> = {}
): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({ state: "initialising" }),
    indexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    observability: vi.fn().mockResolvedValue({ state: "initialising" }),
    nodeIndexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    nodeContent: vi.fn().mockResolvedValue({ state: "initialising" }),
    modelsStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    startModelDownload: vi.fn().mockResolvedValue(undefined),
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
    testChatProvider: vi.fn().mockResolvedValue({
      result: { state: "initialising" },
    }),
    ...overrides,
  };
}
