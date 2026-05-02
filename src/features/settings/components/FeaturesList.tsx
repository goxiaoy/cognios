import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import { FEATURE_CATALOG } from "../data/providerPresets";
import { FeatureRow } from "./FeatureRow";

export function FeaturesList({
  settings,
  client,
  onSettingsChange,
}: {
  settings: SearchSettings;
  client: SearchClient;
  onSettingsChange: (next: SearchSettings) => void;
}) {
  return (
    <div className="settings-card">
      <h2 className="settings-card-title">Features</h2>
      <ul className="features-list">
        {FEATURE_CATALOG.map((meta) => (
          <FeatureRow
            key={meta.featureId}
            meta={meta}
            config={settings.features[meta.featureId]}
            settings={settings}
            client={client}
            onSettingsChange={onSettingsChange}
          />
        ))}
      </ul>
    </div>
  );
}
