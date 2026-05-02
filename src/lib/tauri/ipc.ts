import { invoke } from "@tauri-apps/api/core";
import type {
  IndexStatus,
  LicenseAcceptResponse,
  ModelsStatus,
  NodeIndexStatus,
  SearchQueryInput,
  SearchResponse,
  SidecarEnvelope,
  StartModelDownloadInput,
} from "../contracts/search";
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

// ---- search-sidecar bridge ------------------------------------------------

export async function searchQuery(
  input: SearchQueryInput
): Promise<SidecarEnvelope<SearchResponse>> {
  return invoke<SidecarEnvelope<SearchResponse>>("search_query", { input });
}

export async function getIndexingStatus(): Promise<SidecarEnvelope<IndexStatus>> {
  return invoke<SidecarEnvelope<IndexStatus>>("get_indexing_status");
}

export async function getNodeIndexingStatus(
  nodeId: string
): Promise<SidecarEnvelope<NodeIndexStatus>> {
  return invoke<SidecarEnvelope<NodeIndexStatus>>("get_node_indexing_status", {
    input: { nodeId },
  });
}

export async function getModelsStatus(): Promise<SidecarEnvelope<ModelsStatus>> {
  return invoke<SidecarEnvelope<ModelsStatus>>("get_models_status");
}

export async function acceptModelLicense(
  role: string
): Promise<SidecarEnvelope<LicenseAcceptResponse>> {
  return invoke<SidecarEnvelope<LicenseAcceptResponse>>("accept_model_license", {
    input: { role },
  });
}

/**
 * Kick off a sidecar-side model download. The Rust command
 * subscribes to the SSE stream and re-emits each frame as a Tauri
 * event named `models/progress` (use `useModelDownloadProgress` to
 * subscribe). Resolves when the stream closes; rejects on setup-time
 * failures (sidecar offline, license not accepted).
 */
export async function startModelDownload(
  input: StartModelDownloadInput
): Promise<void> {
  return invoke<void>("start_model_download", { input });
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
