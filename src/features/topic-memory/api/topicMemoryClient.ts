import {
  acceptTopicMemoryProposal,
  archiveTopicMemory,
  dismissTopicMemoryProposal,
  getTopicMemory,
  listTopicMemories,
  refreshTopicMemories,
} from "../../../lib/tauri/ipc";
import type {
  ArchiveTopicInput,
  TopicMemory,
  TopicMemoryDetail,
  TopicMemoryInput,
  TopicMemoryRefreshEnvelope,
  TopicProposalActionInput,
} from "../../../lib/contracts/topicMemory";

export interface TopicMemoryClient {
  list(): Promise<TopicMemory[]>;
  get(input: TopicMemoryInput): Promise<TopicMemoryDetail>;
  refresh(): Promise<TopicMemoryRefreshEnvelope>;
  acceptProposal(input: TopicProposalActionInput): Promise<TopicMemoryDetail>;
  dismissProposal(input: TopicProposalActionInput): Promise<boolean>;
  archive(input: ArchiveTopicInput): Promise<boolean>;
}

export const topicMemoryClient: TopicMemoryClient = {
  list: listTopicMemories,
  get: getTopicMemory,
  refresh: refreshTopicMemories,
  acceptProposal: acceptTopicMemoryProposal,
  dismissProposal: dismissTopicMemoryProposal,
  archive: archiveTopicMemory,
};
