import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { SettingsLayout } from "./SettingsLayout";
import type { SearchClient } from "../../search/types/search";

function makeClient(overrides: Partial<SearchClient> = {}): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({ state: "initialising" }),
    indexStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: { queueDepth: 2, inFlight: ["x"], indexedChunks: 50 },
    }),
    nodeIndexStatus: vi.fn().mockResolvedValue({ state: "initialising" }),
    modelsStatus: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        roles: {
          embedding: {
            role: "embedding",
            state: "ready",
            commit: "abcdef0123",
            licenseAccepted: true,
            requiresAcceptance: false,
          },
        },
      },
    }),
    acceptModelLicense: vi.fn().mockResolvedValue({ state: "initialising" }),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("SettingsLayout", () => {
  it("polls both endpoints on mount and renders model + indexing cards", async () => {
    const client = makeClient();
    render(<SettingsLayout client={client} />);

    // Initial render shows loading hints; first poll fills them in.
    await waitFor(() => {
      expect(screen.getByText("Embedding")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Indexed chunks")).toBeInTheDocument();
    });
    expect(client.modelsStatus).toHaveBeenCalled();
    expect(client.indexStatus).toHaveBeenCalled();
  });

  it("renders both cards independently — failure of one doesn't blank the other", async () => {
    const client = makeClient({
      modelsStatus: vi
        .fn()
        .mockResolvedValue({ state: "unavailable", error: "no model_manager" }),
    });
    render(<SettingsLayout client={client} />);

    await waitFor(() => {
      expect(screen.getByText(/no model_manager/i)).toBeInTheDocument();
    });
    // Indexing card still renders its data.
    await waitFor(() => {
      expect(screen.getByText("Indexed chunks")).toBeInTheDocument();
    });
  });
});
