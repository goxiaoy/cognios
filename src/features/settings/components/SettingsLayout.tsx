import type { SearchClient } from "../../search/types/search";
import { useModelDownloadProgress } from "../hooks/useModelDownloadProgress";
import { useSearchSubsystemStatus } from "../hooks/useSearchSubsystemStatus";
import { IndexingStatusCard } from "./IndexingStatusCard";
import { ModelManagerStatus } from "./ModelManagerStatus";

/**
 * Settings page. Surfaces search-subsystem state and lets the user
 * trigger the two model-lifecycle actions: license acceptance (for
 * gated roles) and download. Provider config + secure API-key
 * storage land in a later commit (Settings part 2c) once the
 * Rust ``keyring`` dependency is in place.
 */
export function SettingsLayout({ client }: { client: SearchClient }) {
  const { models, indexing } = useSearchSubsystemStatus(client);
  const progress = useModelDownloadProgress();

  return (
    <section className="settings-layout" aria-label="Settings">
      <header className="settings-header">
        <p className="muted-copy">
          Status of the search subsystem. Provider configuration ships in a
          follow-up.
        </p>
      </header>
      <div className="settings-grid">
        <ModelManagerStatus
          envelope={models}
          client={client}
          progress={progress}
        />
        <IndexingStatusCard envelope={indexing} />
      </div>
    </section>
  );
}
