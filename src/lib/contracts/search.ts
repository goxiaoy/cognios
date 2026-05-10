/**
 * Mirror of the search-sidecar HTTP response shapes (the Rust DTOs in
 * `src-tauri/src/services/search/client.rs`). Field casing is camelCase
 * to match the Rust `serde(rename_all = "camelCase")` output.
 */

/**
 * Discriminator for the typed envelope every sidecar-bound command
 * returns. The UI inspects this first to decide whether to render
 * results, show a "warming up" hint, or show an unavailable banner.
 */
export type SidecarEnvelopeState = "ready" | "initialising" | "unavailable";

export interface SidecarEnvelope<T> {
  state: SidecarEnvelopeState;
  data?: T;
  error?: string;
}

export type SearchSort = "relevance" | "modified";

export interface SearchQueryInput {
  query: string;
  limit?: number;
  sort?: SearchSort;
  cursor?: string;
}

export interface SearchResult {
  nodeId: string;
  kind: string;
  name: string;
  score: number;
  snippet: string;
  matchedIn: "name" | "content" | "both";
  path?: string | null;
  modifiedAt?: string | null;
  /**
   * Inclusive-start, exclusive-end character offsets of query
   * matches within `snippet`. Sorted, non-overlapping. The frontend
   * wraps each in a `<mark>` span via React text nodes; never via
   * `dangerouslySetInnerHTML` (SEC-FINDING-002).
   */
  matchOffsets?: [number, number][];
}

export interface SearchResponse {
  results: SearchResult[];
  degraded: boolean;
  partial?: { indexed: number; total: number } | null;
  state?: string | null;
  nextCursor?: string | null;
}

export interface IndexStatus {
  queueDepth: number;
  inFlight: string[];
  enhancementInFlight: string[];
  indexedChunks: number;
  enhancementPending: number;
  enhancementFailed: number;
  enhancementTotalImages: number;
}

export interface RecentIndexedNodeCount {
  date: string;
  count: number;
}

export interface LatencySummary {
  sampleCount: number;
  failureCount: number;
  latestMs?: number | null;
  p50Ms?: number | null;
  p90Ms?: number | null;
  p99Ms?: number | null;
}

export interface LatencyTrendPoint {
  bucket: string;
  sampleCount: number;
  failureCount: number;
  p90Ms?: number | null;
  p99Ms?: number | null;
}

export interface SearchObservability {
  recentIndexedNodes: RecentIndexedNodeCount[];
  latency: {
    search: LatencySummary;
    indexing: LatencySummary;
    enhancement: LatencySummary;
    modelDownload: LatencySummary;
  };
  latencyTrends?: {
    search: LatencyTrendPoint[];
    indexing: LatencyTrendPoint[];
    enhancement: LatencyTrendPoint[];
    modelDownload: LatencyTrendPoint[];
  };
  tokenUsage: Array<{
    providerId: string;
    model: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}

export interface SearchObservabilityInput {
  recentDays: 7 | 30;
}

export type NodeIndexState =
  | "pending"
  | "indexing"
  | "indexed"
  | "error"
  | "unknown";

export interface NodeIndexStatus {
  nodeId: string;
  state: NodeIndexState;
  indexedAt?: string | null;
  error?: string | null;
  attempts: number;
}

export type NodeContentChunkRole = "body" | "summary";

export interface NodeContentChunk {
  id: string;
  /**
   * "body" for literal content (text, OCR, PDF, HTML body) or
   * "summary" for generated descriptions (today: image captions;
   * future: document summaries). Pre-2026-05 sidecars omit the
   * field; the Rust DTO defaults it to "body" before reaching the
   * frontend.
   */
  role: NodeContentChunkRole;
  text: string;
}

export interface NodeContent {
  nodeId: string;
  kind?: string | null;
  chunks: NodeContentChunk[];
  joined: string;
  /**
   * Local extract assets referenced by OCR markdown. Keys are the
   * relative paths PaddleOCR emitted in markdown (for example
   * `imgs/crop.png`); values are absolute filesystem paths that the
   * UI converts with Tauri's asset protocol before rendering.
   */
  assets?: Record<string, string>;
}

export type ModelRoleName = "embedding" | "reranker" | "ocr" | "captioner";

export type ModelRoleStateName =
  | "missing"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export interface ModelRoleStatus {
  role: string;
  state: ModelRoleStateName | string;
  /**
   * Upstream model identifier (today: a HuggingFace `owner/repo`
   * slug from the sidecar manifest). Empty string for legacy
   * payloads from pre-2026-05 sidecars; treat empty as "unknown
   * repo, no link target".
   */
  repo: string;
  commit?: string | null;
  error?: string | null;
}

export interface ModelsStatus {
  roles: Record<string, ModelRoleStatus>;
}

export type ModelDownloadStateName =
  | "queued"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

/**
 * One frame from the sidecar's `/models/download/{role}` SSE stream.
 * Rust subscribes, parses each frame, and re-emits it as a Tauri
 * event named `models/progress`.
 */
export interface ModelDownloadEvent {
  role: string;
  state: ModelDownloadStateName | string;
  file?: string | null;
  bytesDownloaded: number;
  bytesTotal?: number | null;
  error?: string | null;
}

export interface StartModelDownloadInput {
  role: string;
}

// ----- Search settings (Phase 1 of feature-oriented Settings) ----------------

/** A user-configured cloud or local provider entry stored in
 * settings.json. References to API keys are by reference only —
 * the real secret lives in the OS keychain. */
export interface ProviderConfig {
  providerId: string;
  enabled: boolean;
  apiKeyRef?: string | null;
  baseUrl?: string | null;
  modelPerCapability: Record<string, string>;
}

/** A user-facing feature toggle. ``enabled=true`` means the feature
 * runs against ``providerId``; ``providerId=null`` means the feature
 * is unbound and effectively off until the user picks one. */
export interface FeatureConfig {
  enabled: boolean;
  providerId?: string | null;
}

/** Top-level persisted search settings. ``needsRestart`` is computed
 * by the sidecar — true when the on-disk settings differ from what
 * the running sidecar booted with in any dispatcher-affecting way. */
export interface SearchSettings {
  version: number;
  providers: Record<string, ProviderConfig>;
  features: Record<string, FeatureConfig>;
  cloudConsentAcked: string[];
  firstRunSkipped: boolean;
  needsRestart: boolean;
}

export interface SetProviderSecretInput {
  providerId: string;
  secret: string;
}

export interface ProviderSecretLookupInput {
  providerId: string;
}

/**
 * Helper to narrow an envelope to its `ready` variant. Returns the
 * inner `data` if present; otherwise `null`. Use this when the caller
 * is happy to treat `initialising` and `unavailable` as "no data yet".
 */
export function unwrapEnvelope<T>(env: SidecarEnvelope<T>): T | null {
  if (env.state === "ready" && env.data !== undefined) {
    return env.data;
  }
  return null;
}
