export type NodeStageState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked";

export type NodeStatusOverall =
  | "idle"
  | "queued"
  | "running"
  | "ready"
  | "partial"
  | "failed"
  | "unsupported";

export type NodeStageImportance = "required" | "optional";

export interface NodeStageError {
  message: string;
  retryable: boolean;
}

export interface NodeStageStatus {
  id: string;
  label: string;
  state: NodeStageState;
  importance: NodeStageImportance;
  message?: string | null;
  detail?: Record<string, unknown> | null;
  error?: NodeStageError | null;
  attempt: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
}

export interface NodeStatusView {
  nodeId: string;
  overall: NodeStatusOverall;
  primaryStageId?: string | null;
  stages: NodeStageStatus[];
  updatedAt: string;
}

export interface NodeStatusSnapshot {
  revision: number;
  nodes: Record<string, NodeStatusView>;
}

export interface NodeStatusChangedEvent {
  revision: number;
  nodeId: string;
  status: NodeStatusView;
}
