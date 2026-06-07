import type { SidecarEnvelope } from "./search";

export interface TopicMemory {
  id: string;
  title: string;
  summary: string;
  status: "active" | "archived" | string;
  confidence: number;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicMemoryCitation {
  nodeId: string;
  chunkId?: string | null;
  chunkRole?: string | null;
  anchorLabel?: string | null;
  path?: string | null;
  page?: number | null;
  timestampMs?: number | null;
}

export interface TopicMemorySource {
  id: string;
  topicId: string;
  nodeId: string;
  nodeTitle: string;
  nodeKind: string;
  path?: string | null;
  chunkId?: string | null;
  chunkRole?: string | null;
  anchorLabel?: string | null;
  citation: TopicMemoryCitation;
  status: "active" | "dismissed" | string;
  confidence: number;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicMemoryItem {
  id: string;
  topicId: string;
  itemType: "claim" | "event" | "decision" | string;
  title: string;
  body: string;
  occurredAt?: string | null;
  citation: TopicMemoryCitation;
  status: "active" | "pending_review" | "dismissed" | string;
  confidence: number;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicMemoryRelationship {
  id: string;
  topicId: string;
  sourceLabel: string;
  targetLabel: string;
  relationType: string;
  citation: TopicMemoryCitation;
  status: "active" | "pending_review" | "dismissed" | string;
  confidence: number;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicMemoryProposal {
  id: string;
  topicId?: string | null;
  proposalType: string;
  title: string;
  bodyJson: string;
  status: "pending" | "accepted" | "dismissed" | string;
  confidence: number;
  rationale: string;
  signature: string;
  createdAt: string;
  updatedAt: string;
}

export interface TopicMemoryDetail {
  topic: TopicMemory;
  sources: TopicMemorySource[];
  items: TopicMemoryItem[];
  relationships: TopicMemoryRelationship[];
  proposals: TopicMemoryProposal[];
}

export interface TopicMemoryRefreshResult {
  topicsCreated: number;
  topicsUpdated: number;
  sourcesApplied: number;
  proposalsCreated: number;
}

export interface TopicMemoryInput {
  topicId: string;
}

export interface TopicProposalActionInput {
  proposalId: string;
}

export interface ArchiveTopicInput {
  topicId: string;
}

export type TopicMemoryRefreshEnvelope = SidecarEnvelope<TopicMemoryRefreshResult>;
