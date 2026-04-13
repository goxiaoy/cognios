import { explorerClient } from "../features/explorer/api/explorerClient";
import { ExplorerLayout } from "../features/explorer/components/ExplorerLayout";

export function App() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Milestone 1</p>
        <h1>Local VFS Explorer</h1>
        <p className="lede">
          CogniOS starts with a persistent local graph. This scaffold already
          boots the desktop app, persists folder nodes, and hydrates the
          Explorer from the Rust backend.
        </p>
      </section>

      <ExplorerLayout client={explorerClient} />
    </main>
  );
}
