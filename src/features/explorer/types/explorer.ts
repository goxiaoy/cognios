import type {
  CreateFolderInput,
  CreateMountInput,
  CreateUrlInput,
  DeleteNodeInput,
  ExplorerNode,
  ExplorerSnapshot,
  RenameNodeInput,
  RetryUrlInput
} from "../../../lib/contracts/vfs";

export type {
  CreateFolderInput,
  CreateMountInput,
  CreateUrlInput,
  DeleteNodeInput,
  ExplorerNode,
  ExplorerSnapshot,
  RenameNodeInput,
  RetryUrlInput
};

export interface ExplorerClient {
  getExplorerSnapshot(): Promise<ExplorerSnapshot>;
  createFolder(input: CreateFolderInput): Promise<ExplorerSnapshot>;
  createMount(input: CreateMountInput): Promise<ExplorerSnapshot>;
  createUrl(input: CreateUrlInput): Promise<ExplorerSnapshot>;
  renameNode(input: RenameNodeInput): Promise<ExplorerSnapshot>;
  deleteNode(input: DeleteNodeInput): Promise<ExplorerSnapshot>;
  retryUrl(input: RetryUrlInput): Promise<void>;
}

export interface ExplorerTreeNode extends ExplorerNode {
  depth: number;
}
