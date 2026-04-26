import { invoke } from "@tauri-apps/api/core";
import type {
  CreateFolderInput,
  CreateMountInput,
  CreateNoteInput,
  CreateUrlInput,
  DeleteNodeInput,
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
  return invoke<ExplorerSnapshot>("create_mount", { input });
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
