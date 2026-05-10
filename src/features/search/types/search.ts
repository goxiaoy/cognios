import type {
  TestChatProviderInput,
  TestChatProviderResult,
} from "../../../lib/contracts/chat";
import type {
  IndexStatus,
  ModelDownloadEvent,
  ModelsStatus,
  NodeContent,
  NodeContentChunk,
  NodeIndexStatus,
  ProviderSecretLookupInput,
  SearchObservability,
  SearchQueryInput,
  SearchResponse,
  SearchResult,
  SearchSettings,
  SearchSort,
  SetProviderSecretInput,
  SidecarEnvelope,
  StartModelDownloadInput,
} from "../../../lib/contracts/search";

export type {
  IndexStatus,
  ModelDownloadEvent,
  ModelsStatus,
  NodeContent,
  NodeContentChunk,
  NodeIndexStatus,
  ProviderSecretLookupInput,
  SearchObservability,
  SearchQueryInput,
  SearchResponse,
  SearchResult,
  SearchSettings,
  SearchSort,
  SetProviderSecretInput,
  SidecarEnvelope,
  StartModelDownloadInput,
};

/**
 * Feature-scoped client interface. Components depend on this rather
 * than `lib/tauri/ipc.ts` directly so they can be tested with mocks
 * (mirrors the `ExplorerClient` pattern used elsewhere in the app).
 */
export interface SearchClient {
  search(input: SearchQueryInput): Promise<SidecarEnvelope<SearchResponse>>;
  indexStatus(): Promise<SidecarEnvelope<IndexStatus>>;
  observability(): Promise<SidecarEnvelope<SearchObservability>>;
  nodeIndexStatus(nodeId: string): Promise<SidecarEnvelope<NodeIndexStatus>>;
  nodeContent(nodeId: string): Promise<SidecarEnvelope<NodeContent>>;
  modelsStatus(): Promise<SidecarEnvelope<ModelsStatus>>;
  startModelDownload(input: StartModelDownloadInput): Promise<void>;
  /** Fetch the persisted search settings + needsRestart flag. */
  settings(): Promise<SidecarEnvelope<SearchSettings>>;
  /** Replace the persisted search settings. Sidecar validates +
   * recomputes ``needsRestart``. */
  updateSettings(
    settings: SearchSettings
  ): Promise<SidecarEnvelope<SearchSettings>>;
  /** Trigger a graceful sidecar restart so a settings change takes
   * effect. Resolves once the new sidecar is up and the runtime
   * file rendezvous succeeds. */
  restartSidecar(): Promise<void>;
  /** Read settings directly from disk via the Rust fallback path —
   * used when the sidecar is unreachable. */
  readSettingsFallback(): Promise<SearchSettings>;
  /** Write a provider's API key to the OS keychain. */
  setProviderSecret(input: SetProviderSecretInput): Promise<void>;
  /** Probe whether the keychain has a secret for the provider —
   * never returns the secret itself. */
  hasProviderSecret(input: ProviderSecretLookupInput): Promise<boolean>;
  /** Remove a provider's secret from the keychain. Idempotent. */
  deleteProviderSecret(input: ProviderSecretLookupInput): Promise<void>;
  /** Probe a chat provider endpoint without persisting settings. */
  testChatProvider(input: TestChatProviderInput): Promise<TestChatProviderResult>;
}
