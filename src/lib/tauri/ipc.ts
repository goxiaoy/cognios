import { invoke } from "@tauri-apps/api/core";
import type {
  CreateFolderInput,
  DuplicateMountError,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
  MountSetupContext,
  ExplorerSnapshot,
  RenameNodeInput,
  RetryUrlInput,
} from "../contracts/vfs";

export async function getExplorerSnapshot(): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("get_explorer_snapshot");
}

export async function createFolder(
  input: CreateFolderInput
): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("create_folder", { input });
}

export async function createMount(
  input: CreateMountInput
): Promise<ExplorerSnapshot> {
  try {
    return await invoke<ExplorerSnapshot>("create_mount", { input });
  } catch (error) {
    if (isDuplicateMountError(error)) {
      throw error;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function getMountSetupContext(): Promise<MountSetupContext> {
  return invoke<MountSetupContext>("get_mount_setup_context");
}

export async function createUrl(
  input: CreateUrlInput
): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("create_url", { input });
}

export async function renameNode(
  input: RenameNodeInput
): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("rename_node", { input });
}

export async function deleteNode(
  input: DeleteNodeInput
): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("delete_node", { input });
}

export async function createNote(
  input: CreateNoteInput
): Promise<ExplorerSnapshot> {
  return invoke<ExplorerSnapshot>("create_note", { input });
}

export async function getNoteContent(noteId: string): Promise<string> {
  return invoke<string>("get_note_content", { input: { noteId } });
}

export async function saveNoteContent(
  noteId: string,
  body: string
): Promise<void> {
  return invoke<void>("save_note_content", { input: { noteId, body } });
}

export async function retryUrl(input: RetryUrlInput): Promise<void> {
  return invoke<void>("retry_url", { input });
}

export async function getNodeThumbnail(nodeId: string): Promise<string> {
  return invoke<string>("get_node_thumbnail", { input: { nodeId } });
}

export async function readFileContent(nodeId: string): Promise<string> {
  return invoke<string>("read_file_content", { input: { nodeId } });
}

export async function showNodeInFileManager(nodeId: string): Promise<void> {
  return invoke<void>("show_node_in_file_manager", { input: { nodeId } });
}

function isDuplicateMountError(error: unknown): error is DuplicateMountError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<DuplicateMountError>;
  return (
    candidate.kind === "duplicateMount" &&
    typeof candidate.mountId === "string" &&
    typeof candidate.absolutePath === "string"
  );
}
