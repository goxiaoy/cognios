export type NodeKind = "folder" | "url" | "mount" | "directory" | "file" | "note";

export type NodeState =
  | "ready"
  | "pending"
  | "indexing"
  | "indexed"
  | "error"
  | "unavailable";

export interface ExplorerNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  state: NodeState;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
  children: ExplorerNode[];
}

export interface ExplorerSnapshot {
  roots: ExplorerNode[];
}

export interface CreateFolderInput {
  name: string;
  parentId?: string | null;
}

export interface CreateNoteInput {
  parentId?: string | null;
}

export interface CreateMountInput {
  path: string;
  parentId?: string | null;
  ignoreConfig?: string;
}

export interface CreateUrlInput {
  url: string;
  parentId?: string | null;
}

export interface RenameNodeInput {
  nodeId: string;
  newName: string;
}

export interface DeleteNodeInput {
  nodeId: string;
  cascade?: boolean;
}

export interface RetryUrlInput {
  nodeId: string;
}

export const DEFAULT_MOUNT_IGNORE_CONFIG = `node_modules/
.git/
dist/
target/
*.log
`;
