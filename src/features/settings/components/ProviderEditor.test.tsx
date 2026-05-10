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
import { presetById } from "../data/providerPresets";
import { ProviderEditor } from "./ProviderEditor";

afterEach(() => cleanup());

const OPENAI = presetById("openai")!;
const LOCAL_GTE = presetById("local-gte")!;
const LOCAL_OLLAMA = presetById("local-ollama")!;

function baseSettings(): SearchSettings {
  return {
    version: 1,
    providers: {},
    features: {},
    // Pre-ack OpenAI so the editor's save flow tests don't all need
    // to click through the cloud-egress dialog (CloudEgressConsentDialog
    // has its own dedicated test suite covering the gating behavior).
    cloudConsentAcked: ["openai"],
    firstRunSkipped: false,
    needsRestart: false,
  };
}

describe("ProviderEditor", () => {
  it("renders 'no credentials' info for local providers", () => {
    render(
      <ProviderEditor
        preset={LOCAL_GTE}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient()}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText(/no credentials required/i)).toBeInTheDocument();
  });

  it("lets configurable local providers persist endpoint settings", async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    const onSettingsChange = vi.fn();
    render(
      <ProviderEditor
        preset={LOCAL_OLLAMA}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({ updateSettings })}
        onSettingsChange={onSettingsChange}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "http://localhost:11435" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalled();
    });
    const arg = updateSettings.mock.calls[0][0];
    expect(arg.providers["local-ollama"]).toMatchObject({
      providerId: "local-ollama",
      enabled: true,
      apiKeyRef: null,
      baseUrl: "http://localhost:11435",
      modelPerCapability: {},
    });
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it("tests configurable local provider connectivity without saving", async () => {
    const testChatProvider = vi.fn().mockResolvedValue({
      result: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [{ id: "qwen2.5:7b", name: "qwen2.5:7b" }],
          cached: false,
          cacheExpiresAt: null,
          warnings: [],
        },
      },
    });
    render(
      <ProviderEditor
        preset={LOCAL_OLLAMA}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({ testChatProvider })}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "http://localhost:11435" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    await waitFor(() => {
      expect(testChatProvider).toHaveBeenCalledWith({
        providerId: "local-ollama",
        baseUrl: "http://localhost:11435",
      });
    });
    const button = await screen.findByRole("button", {
      name: /connected · 1 model/i,
    });
    expect(button).toHaveClass("is-success");
  });

  it("surfaces configurable local provider test failures", async () => {
    render(
      <ProviderEditor
        preset={LOCAL_OLLAMA}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({
          testChatProvider: vi.fn().mockResolvedValue({
            result: {
              state: "ready",
              data: {
                state: "provider_error",
                providerId: "local-ollama",
                models: [],
                cached: false,
                cacheExpiresAt: null,
                warnings: ["local-ollama: local runtime unreachable"],
              },
            },
          }),
        })}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(
      await screen.findByText(/local runtime unreachable/i)
    ).toBeInTheDocument();
  });

  it("shows API key input when cloud provider has no key configured", async () => {
    render(
      <ProviderEditor
        preset={OPENAI}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({
          hasProviderSecret: vi.fn().mockResolvedValue(false),
        })}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    });
  });

  it("saves a new key + persists settings + invokes onSettingsChange", async () => {
    const setProviderSecret = vi.fn().mockResolvedValue(undefined);
    const onSettingsChange = vi.fn();
    const updateSettings = vi.fn().mockResolvedValue({
      state: "ready",
      data: baseSettings(),
    });
    render(
      <ProviderEditor
        preset={OPENAI}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({
          setProviderSecret,
          updateSettings,
          hasProviderSecret: vi.fn().mockResolvedValue(false),
        })}
        onSettingsChange={onSettingsChange}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-test-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(setProviderSecret).toHaveBeenCalledWith({
        providerId: "openai",
        secret: "sk-test-1234",
      });
    });
    await waitFor(() => {
      expect(onSettingsChange).toHaveBeenCalled();
    });
    expect(updateSettings).toHaveBeenCalled();
    const arg = updateSettings.mock.calls[0][0];
    expect(arg.providers.openai.apiKeyRef).toBe(
      "keychain://cognios-search/provider:openai"
    );
  });

  it("surfaces an error when setProviderSecret rejects", async () => {
    render(
      <ProviderEditor
        preset={OPENAI}
        config={null}
        settings={baseSettings()}
        client={makeStubSearchClient({
          setProviderSecret: vi
            .fn()
            .mockRejectedValue(new Error("validate failed")),
          hasProviderSecret: vi.fn().mockResolvedValue(false),
        })}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "sk-bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(screen.getByText(/validate failed/i)).toBeInTheDocument();
    });
  });

  it("shows 'configured ✓' + Edit affordance when key already exists", async () => {
    render(
      <ProviderEditor
        preset={OPENAI}
        config={{
          providerId: "openai",
          enabled: true,
          apiKeyRef: "keychain://cognios-search/provider:openai",
          baseUrl: null,
          modelPerCapability: {},
        }}
        settings={baseSettings()}
        client={makeStubSearchClient({
          hasProviderSecret: vi.fn().mockResolvedValue(true),
        })}
        onSettingsChange={vi.fn()}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(screen.getByText(/configured ✓/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeInTheDocument();
  });

  it("Remove key calls deleteProviderSecret + closes editor", async () => {
    const deleteProviderSecret = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const settings: SearchSettings = {
      ...baseSettings(),
      providers: {
        openai: {
          providerId: "openai",
          enabled: true,
          apiKeyRef: "keychain://cognios-search/provider:openai",
          baseUrl: null,
          modelPerCapability: {},
        },
      },
    };
    render(
      <ProviderEditor
        preset={OPENAI}
        config={settings.providers.openai}
        settings={settings}
        client={makeStubSearchClient({
          deleteProviderSecret,
          hasProviderSecret: vi.fn().mockResolvedValue(true),
          updateSettings: vi.fn().mockResolvedValue({
            state: "ready",
            data: baseSettings(),
          }),
        })}
        onSettingsChange={vi.fn()}
        onClose={onClose}
      />
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /remove key/i })
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
    await waitFor(() => {
      expect(deleteProviderSecret).toHaveBeenCalledWith({
        providerId: "openai",
      });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
