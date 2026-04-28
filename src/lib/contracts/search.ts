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
  indexedChunks: number;
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
  commit?: string | null;
  licenseAccepted: boolean;
  requiresAcceptance: boolean;
  error?: string | null;
}

export interface ModelsStatus {
  roles: Record<string, ModelRoleStatus>;
}

export interface LicenseAcceptResponse {
  accepted: boolean;
  role: string;
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
