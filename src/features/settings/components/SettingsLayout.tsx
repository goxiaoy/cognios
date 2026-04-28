import type { SearchClient } from "../../search/types/search";
import { useSearchSubsystemStatus } from "../hooks/useSearchSubsystemStatus";
import { IndexingStatusCard } from "./IndexingStatusCard";
import { ModelManagerStatus } from "./ModelManagerStatus";

/**
 * Read-only Settings page. Surfaces what the search subsystem is
 * doing right now — model state per role, queue depth, indexed
 * chunk count — so the user can verify the sidecar is healthy
 * without dropping into a shell.
 *
 * The write-side controls (provider config form, license-acceptance
 * modal, manual download trigger, secure-storage of API keys) ride
 * on a Rust ``keyring`` dependency + new IPC commands; those land
 * in a follow-up commit so this page can ship and the read path
 * can be exercised before the keychain plumbing.
 */
export function SettingsLayout({ client }: { client: SearchClient }) {
  const { models, indexing } = useSearchSubsystemStatus(client);

  return (
    <section className="settings-layout" aria-label="Settings">
      <header className="settings-header">
        <p className="muted-copy">
          Status of the search subsystem. Configuration controls (provider
          config, model downloads, license acceptance) ship in a follow-up.
        </p>
      </header>
      <div className="settings-grid">
        <ModelManagerStatus envelope={models} />
        <IndexingStatusCard envelope={indexing} />
      </div>
    </section>
  );
}
