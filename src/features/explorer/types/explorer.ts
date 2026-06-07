import type {
  CreateFolderInput,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
  DuplicateMountError,
  ExistingMount,
  ExplorerNode,
  ExplorerSnapshot,
  MountSetupContext,
  MountSuggestion,
  RenameNodeInput,
  RetryUrlInput,
} from "../../../lib/contracts/vfs";
import type { NodeStatusSnapshot } from "../../../lib/contracts/nodeStatus";
import type { TopicMemory } from "../../../lib/contracts/topicMemory";

export type {
  CreateFolderInput,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
  DuplicateMountError,
  ExistingMount,
  ExplorerNode,
  ExplorerSnapshot,
  MountSetupContext,
  MountSuggestion,
  RenameNodeInput,
  RetryUrlInput,
};

export interface ExplorerClient {
  getExplorerSnapshot(): Promise<ExplorerSnapshot>;
  getNodeStatusSnapshot?(): Promise<NodeStatusSnapshot>;
  getMountSetupContext(): Promise<MountSetupContext>;
  createFolder(input: CreateFolderInput): Promise<ExplorerSnapshot>;
  createMount(input: CreateMountInput): Promise<ExplorerSnapshot>;
  createNote(input: CreateNoteInput): Promise<ExplorerSnapshot>;
  createUrl(input: CreateUrlInput): Promise<ExplorerSnapshot>;
  renameNode(input: RenameNodeInput): Promise<ExplorerSnapshot>;
  deleteNode(input: DeleteNodeInput): Promise<ExplorerSnapshot>;
  reindexNode(input: { nodeId: string }): Promise<{ enqueued: number }>;
  retryUrl(input: RetryUrlInput): Promise<void>;
  getNodeThumbnail(nodeId: string): Promise<string>;
  getNoteContent(noteId: string): Promise<string>;
  saveNoteContent(noteId: string, body: string): Promise<void>;
  readFileContent(nodeId: string): Promise<string>;
  showNodeInFileManager(nodeId: string): Promise<void>;
  showNodeExtractArtifacts(nodeId: string): Promise<void>;
  retranscribeVoiceNote?(noteId: string): Promise<unknown>;
  listTopicMemoriesForNode?(input: { nodeId: string }): Promise<TopicMemory[]>;
}
