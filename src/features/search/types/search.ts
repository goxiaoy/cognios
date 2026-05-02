import type {
  IndexStatus,
  LicenseAcceptResponse,
  ModelDownloadEvent,
  ModelsStatus,
  NodeIndexStatus,
  SearchQueryInput,
  SearchResponse,
  SearchResult,
  SearchSort,
  SidecarEnvelope,
  StartModelDownloadInput,
} from "../../../lib/contracts/search";

export type {
  IndexStatus,
  LicenseAcceptResponse,
  ModelDownloadEvent,
  ModelsStatus,
  NodeIndexStatus,
  SearchQueryInput,
  SearchResponse,
  SearchResult,
  SearchSort,
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
  nodeIndexStatus(nodeId: string): Promise<SidecarEnvelope<NodeIndexStatus>>;
  modelsStatus(): Promise<SidecarEnvelope<ModelsStatus>>;
  acceptModelLicense(
    role: string
  ): Promise<SidecarEnvelope<LicenseAcceptResponse>>;
  startModelDownload(input: StartModelDownloadInput): Promise<void>;
}
