export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatSourceKind = "workspace" | "web" | "mixed";
export type ChatClusterStatus =
  | "candidate"
  | "accepted"
  | "excluded"
  | "suggested";

export interface ChatSession {
  id: string;
  title: string;
  boundNoteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionMemory {
  available: boolean;
  status: string;
  revision: number;
  lastSuccessfulRevision: number;
  lastIncludedMessageOrdinal: number;
  providerId?: string | null;
  modelId?: string | null;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  body: string;
  ordinal: number;
  metadataJson: string;
  createdAt: string;
}

export interface ChatSourceCluster {
  id: string;
  sessionId: string;
  turnMessageId: string | null;
  title: string;
  sourceKind: ChatSourceKind;
  status: ChatClusterStatus;
  summary: string;
  score: number;
  sourcesJson: string;
  createdAt: string;
}

export interface ChatSessionDetail {
  session: ChatSession;
  messages: ChatMessage[];
  clusters: ChatSourceCluster[];
  memory?: ChatSessionMemory | null;
}

export interface CreateChatSessionInput {
  title?: string | null;
}

export interface ChatSessionInput {
  sessionId: string;
}

export interface UpdateChatSessionTitleInput {
  sessionId: string;
  title: string;
}

export interface AppendChatMessageInput {
  sessionId: string;
  role: ChatMessageRole;
  body: string;
  metadataJson?: string | null;
}

export interface RecordChatClusterInput {
  sessionId: string;
  turnMessageId?: string | null;
  title: string;
  sourceKind: ChatSourceKind;
  status: ChatClusterStatus;
  summary: string;
  score?: number;
  sourcesJson?: string | null;
}

export interface BindChatNoteInput {
  sessionId: string;
  noteId: string;
}

export interface DeleteChatSessionResult {
  deleted: boolean;
}

export interface GetChatSessionMemoryResult {
  available: boolean;
  body?: string | null;
  revision?: number | null;
}

export interface ExportChatSessionMemoryResult {
  noteId: string;
  snapshot: import("./vfs").ExplorerSnapshot;
}

export interface TriggerChatSessionMemoryOpportunityInput {
  sessionId: string;
  reason: "session_switch" | "idle" | string;
}

export interface ChatSessionMemoryEventPayload {
  sessionId: string;
  revision: number;
}

export interface ChatTurnSource {
  sourceId: string;
  sourceKind: ChatSourceKind;
  title: string;
  snippet: string;
  citation: string;
  path?: string | null;
  score: number;
}

export interface ChatTurnCluster {
  clusterId: string;
  title: string;
  sourceKind: "workspace" | "web" | "mixed";
  status: ChatClusterStatus;
  summary: string;
  score: number;
  sources: ChatTurnSource[];
}

export interface ChatContextNode {
  nodeId: string;
  title: string;
  kind?: string | null;
  path?: string | null;
  snippet?: string | null;
  content?: string | null;
}

export interface ChatTurnResponse {
  state:
    | "needs_redirect"
    | "provider_unavailable"
    | "provider_error"
    | "unsupported_agentic_provider"
    | "tool_limit_exceeded"
    | "ready"
    | string;
  clusters: ChatTurnCluster[];
  answer?: string | null;
  citations: unknown[];
  warnings: string[];
  provider?: unknown;
  toolEvents?: unknown[];
}

export interface ChatTurnStreamEvent {
  event: "metadata" | "delta" | "final" | string;
  delta?: string | null;
  turn?: ChatTurnResponse | null;
  clusters?: ChatTurnCluster[];
  citations?: unknown[];
  warnings?: string[];
  toolEvents?: unknown[];
  error?: string | null;
}

export interface ChatTurnStreamPayload {
  turnEventId: string;
  event: ChatTurnStreamEvent;
}

export interface ChatModel {
  id: string;
  name: string;
  supportsAgentic?: boolean;
  unavailableReason?: string | null;
}

export interface ChatModelsResponse {
  state:
    | "ready"
    | "provider_unavailable"
    | "provider_error"
    | string;
  providerId?: string | null;
  models: ChatModel[];
  cached: boolean;
  cacheExpiresAt?: number | null;
  warnings: string[];
}

export interface StartChatTurnInput {
  sessionId: string;
  query: string;
  turnEventId?: string | null;
  model?: string | null;
  acceptedClusterIds?: string[];
  includeWeb?: boolean;
  contextNodes?: ChatContextNode[];
}

export interface StartChatTurnResult {
  turn: import("./search").SidecarEnvelope<ChatTurnResponse>;
}

export interface GetChatModelsResult {
  models: import("./search").SidecarEnvelope<ChatModelsResponse>;
}

export interface TestChatProviderInput {
  providerId: string;
  baseUrl?: string | null;
}

export interface TestChatProviderResult {
  result: import("./search").SidecarEnvelope<ChatModelsResponse>;
}
