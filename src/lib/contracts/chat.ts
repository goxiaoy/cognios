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
}

export interface CreateChatSessionInput {
  title?: string | null;
}

export interface ChatSessionInput {
  sessionId: string;
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

export interface ChatTurnResponse {
  state:
    | "awaiting_source_confirmation"
    | "needs_redirect"
    | "provider_unavailable"
    | "provider_error"
    | "ready"
    | string;
  clusters: ChatTurnCluster[];
  answer?: string | null;
  citations: unknown[];
  warnings: string[];
  provider?: unknown;
}

export interface ChatModel {
  id: string;
  name: string;
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
  model?: string | null;
  acceptedClusterIds?: string[];
  includeWeb?: boolean;
}

export interface StartChatTurnResult {
  turn: import("./search").SidecarEnvelope<ChatTurnResponse>;
}

export interface GetChatModelsResult {
  models: import("./search").SidecarEnvelope<ChatModelsResponse>;
}
