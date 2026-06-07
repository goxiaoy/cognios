import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SearchSettings } from "../../lib/contracts/search";
import { makeStubSearchClient } from "../../features/search/types/test-helpers";
import type { SearchClient } from "../../features/search/types/search";
import { useAutoModelDownload } from "./useAutoModelDownload";

function HookHarness({ client }: { client: SearchClient }) {
  useAutoModelDownload(client);
  return null;
}

function readySettings(): SearchSettings {
  return {
    version: 1,
    providers: {},
    features: {
      "voice-notes": { enabled: true, providerId: "local-vllm-asr" },
      "result-reranking": { enabled: true, providerId: "local-gte-reranker" },
      "semantic-search": { enabled: true, providerId: "local-gte" },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  };
}

afterEach(() => cleanup());

describe("useAutoModelDownload", () => {
  it("starts required startup downloads in embedding then reranker order", async () => {
    const startModelDownload = vi.fn().mockResolvedValue(undefined);
    const client = makeStubSearchClient({
      settings: vi.fn().mockResolvedValue({ state: "ready", data: readySettings() }),
      modelsStatus: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          roles: {
            reranker: {
              role: "reranker",
              state: "missing",
              repo: "onnx-community/gte-multilingual-reranker-base",
            },
            embedding: {
              role: "embedding",
              state: "missing",
              repo: "onnx-community/gte-multilingual-base",
            },
          },
        },
      }),
      startModelDownload,
    });

    render(<HookHarness client={client} />);

    await waitFor(() => {
      expect(startModelDownload).toHaveBeenCalledTimes(2);
    });
    expect(startModelDownload.mock.calls.map(([input]) => input.role)).toEqual([
      "embedding",
      "reranker",
    ]);
  });

  it("does not start a ModelManager download for vLLM-backed voice notes", async () => {
    const startModelDownload = vi.fn().mockResolvedValue(undefined);
    const client = makeStubSearchClient({
      settings: vi.fn().mockResolvedValue({
        state: "ready",
        data: {
          ...readySettings(),
          features: {
            "voice-notes": { enabled: true, providerId: "local-vllm-asr" },
          },
          firstRunSkipped: true,
        },
      }),
      modelsStatus: vi.fn().mockResolvedValue({
        state: "ready",
        data: { roles: {} },
      }),
      startModelDownload,
    });

    render(<HookHarness client={client} />);

    await waitFor(() => expect(client.modelsStatus).not.toHaveBeenCalled());
    expect(startModelDownload).not.toHaveBeenCalled();
  });
});
