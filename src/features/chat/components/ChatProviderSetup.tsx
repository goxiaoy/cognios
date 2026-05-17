import { AppSelect } from "../../../components/FormControls";
import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { ProviderEditor } from "../../settings/components/ProviderEditor";
import { PROVIDER_PRESETS, type ProviderPreset } from "../../settings/data/providerPresets";

export const DEFAULT_CHAT_PROVIDER_ID = "local-ollama";
export const CHAT_PROVIDER_PRESETS = PROVIDER_PRESETS.filter((preset) =>
  preset.capabilities.includes("chat")
);

export function ChatProviderSetup({
  settings,
  selectedProviderId,
  providerStatus,
  client,
  onSelectedProviderChange,
  onSettingsChange,
}: {
  settings: SearchSettings;
  selectedProviderId: string;
  providerStatus: string | null;
  client: SearchClient;
  onSelectedProviderChange: (providerId: string) => void;
  onSettingsChange: (next: SearchSettings) => void;
}) {
  const selectedPreset =
    CHAT_PROVIDER_PRESETS.find((preset) => preset.providerId === selectedProviderId) ??
    CHAT_PROVIDER_PRESETS[0];

  if (!selectedPreset) return null;

  const editorSettings = settingsWithChatProvider(settings, selectedPreset);

  return (
    <section className="chat-provider-setup" aria-label="Set up chat provider">
      <div className="chat-provider-setup-head">
        <div>
          <p className="chat-provider-setup-kicker">Provider required</p>
          <h3>Set up Chat before sending</h3>
        </div>
        <AppSelect
          label="Provider"
          value={selectedPreset.providerId}
          onChange={onSelectedProviderChange}
          options={CHAT_PROVIDER_PRESETS.map((preset) => ({
            value: preset.providerId,
            label: providerDisplayName(preset),
          }))}
          className="chat-provider-picker"
        />
      </div>
      <p className="chat-provider-setup-copy">
        Choose a provider, save it here, then send your first message.
      </p>
      {providerStatus ? (
        <p className="chat-provider-setup-note">{providerStatus}</p>
      ) : null}
      <ProviderEditor
        key={selectedPreset.providerId}
        preset={selectedPreset}
        config={editorSettings.providers[selectedPreset.providerId] ?? null}
        settings={editorSettings}
        client={client}
        onSettingsChange={onSettingsChange}
        onClose={() => {}}
        allowRemove={false}
      />
    </section>
  );
}

function settingsWithChatProvider(
  settings: SearchSettings,
  preset: ProviderPreset
): SearchSettings {
  return {
    ...settings,
    features: {
      ...settings.features,
      chat: {
        enabled: true,
        providerId: preset.providerId,
      },
    },
  };
}

function providerDisplayName(preset: ProviderPreset): string {
  return preset.displayName.replace(/^Local\s+/, "");
}
