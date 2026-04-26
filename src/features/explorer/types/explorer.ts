import type {
  CreateFolderInput,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
  ExplorerNode,
  ExplorerSnapshot,
  RenameNodeInput,
  RetryUrlInput,
} from "../../../lib/contracts/vfs";

export type {
  CreateFolderInput,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
  ExplorerNode,
  ExplorerSnapshot,
  RenameNodeInput,
  RetryUrlInput,
};

export interface ExplorerClient {
  getExplorerSnapshot(): Promise<ExplorerSnapshot>;
  createFolder(input: CreateFolderInput): Promise<ExplorerSnapshot>;
  createMount(input: CreateMountInput): Promise<ExplorerSnapshot>;
  createNote(input: CreateNoteInput): Promise<ExplorerSnapshot>;
  createUrl(input: CreateUrlInput): Promise<ExplorerSnapshot>;
  renameNode(input: RenameNodeInput): Promise<ExplorerSnapshot>;
  deleteNode(input: DeleteNodeInput): Promise<ExplorerSnapshot>;
  retryUrl(input: RetryUrlInput): Promise<void>;
  getNodeThumbnail(nodeId: string): Promise<string>;
  getNoteContent(noteId: string): Promise<string>;
  saveNoteContent(noteId: string, body: string): Promise<void>;
  readFileContent(nodeId: string): Promise<string>;
}

