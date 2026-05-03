export type NodeKind = "folder" | "url" | "mount" | "directory" | "file" | "note";

export type NodeState =
  | "ready"
  | "pending"
  | "indexing"
  | "indexed"
  | "error"
  | "unavailable"
  | "unsupported";

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

export interface ExistingMount {
  nodeId: string;
  name: string;
  absolutePath: string;
}

export interface MountSuggestion {
  name: string;
  path: string;
  source: "obsidian";
}

export interface MountSetupContext {
  suggestedFolders: MountSuggestion[];
  existingMounts: ExistingMount[];
}

export interface DuplicateMountError {
  kind: "duplicateMount";
  mountId: string;
  mountName: string;
  absolutePath: string;
  message: string;
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

/**
 * Default ignore patterns for new mounts. Hidden entries (anything
 * starting with ``.``) are skipped wholesale — most are noise
 * (``.git``, ``.DS_Store``, ``.vscode``, ``.idea``, ``.env``,
 * ``.cache``, ``.pytest_cache``, …) and users who genuinely want
 * to index a dotfile can edit the per-mount config to drop the
 * wildcard.
 *
 * Patterns follow gitignore syntax (the Rust ``ignore`` crate that
 * powers the mount watcher uses the same parser as ripgrep).
 */
export const DEFAULT_MOUNT_IGNORE_CONFIG = `.*
node_modules/
dist/
target/
*.log
`;
