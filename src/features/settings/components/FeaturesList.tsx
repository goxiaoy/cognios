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
    <div className="settings-card features-card">
      <div className="features-card-header">
        <h2 className="settings-card-title features-card-title">
          Features
          <span className="features-card-count">
            {FEATURE_CATALOG.length} capabilities
          </span>
        </h2>
      </div>
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
