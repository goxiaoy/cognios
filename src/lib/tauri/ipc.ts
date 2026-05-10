import { invoke } from "@tauri-apps/api/core";
import type {
  AppendChatMessageInput,
  BindChatNoteInput,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatSessionInput,
  ChatSourceCluster,
  CreateChatSessionInput,
  DeleteChatSessionResult,
  ExportChatSessionMemoryResult,
  GetChatSessionMemoryResult,
  GetChatModelsResult,
  RecordChatClusterInput,
  StartChatTurnInput,
  StartChatTurnResult,
  TestChatProviderInput,
  TriggerChatSessionMemoryOpportunityInput,
  TestChatProviderResult,
  UpdateChatSessionTitleInput,
} from "../contracts/chat";
import type {
  IndexStatus,
  ModelsStatus,
  NodeContent,
  NodeIndexStatus,
  ProviderSecretLookupInput,
  SearchObservability,
  SearchObservabilityInput,
  SearchQueryInput,
  SearchResponse,
  SearchSettings,
  SetProviderSecretInput,
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

export interface ReindexNodeResult {
  enqueued: number;
}

export async function reindexNode(input: {
  nodeId: string;
}): Promise<ReindexNodeResult> {
  return invoke<ReindexNodeResult>("reindex_node", { input });
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

export async function showNodeExtractArtifacts(nodeId: string): Promise<void> {
  return invoke<void>("show_node_extract_artifacts", { input: { nodeId } });
}

// ---- chat sessions -------------------------------------------------------

export async function createChatSession(
  input: CreateChatSessionInput = {}
): Promise<ChatSession> {
  return invoke<ChatSession>("create_chat_session", { input });
}

export async function listChatSessions(): Promise<ChatSession[]> {
  return invoke<ChatSession[]>("list_chat_sessions");
}

export async function getChatSession(
  input: ChatSessionInput
): Promise<ChatSessionDetail> {
  return invoke<ChatSessionDetail>("get_chat_session", { input });
}

export async function getChatSessionMemory(
  input: ChatSessionInput
): Promise<GetChatSessionMemoryResult> {
  return invoke<GetChatSessionMemoryResult>("get_chat_session_memory", { input });
}

export async function exportChatSessionMemory(
  input: ChatSessionInput
): Promise<ExportChatSessionMemoryResult> {
  return invoke<ExportChatSessionMemoryResult>("export_chat_session_memory", { input });
}

export async function deleteChatSession(
  input: ChatSessionInput
): Promise<DeleteChatSessionResult> {
  return invoke<DeleteChatSessionResult>("delete_chat_session", { input });
}

export async function updateChatSessionTitle(
  input: UpdateChatSessionTitleInput
): Promise<ChatSession> {
  return invoke<ChatSession>("update_chat_session_title", { input });
}

export async function appendChatMessage(
  input: AppendChatMessageInput
): Promise<ChatMessage> {
  return invoke<ChatMessage>("append_chat_message", { input });
}

export async function recordChatCluster(
  input: RecordChatClusterInput
): Promise<ChatSourceCluster> {
  return invoke<ChatSourceCluster>("record_chat_cluster", { input });
}

export async function bindChatNote(input: BindChatNoteInput): Promise<ChatSession> {
  return invoke<ChatSession>("bind_chat_note", { input });
}

export async function startChatTurn(
  input: StartChatTurnInput
): Promise<StartChatTurnResult> {
  return invoke<StartChatTurnResult>("start_chat_turn", { input });
}

export async function triggerChatSessionMemoryOpportunity(
  input: TriggerChatSessionMemoryOpportunityInput
): Promise<void> {
  return invoke<void>("trigger_chat_session_memory_opportunity", { input });
}

export async function getChatModels(): Promise<GetChatModelsResult> {
  return invoke<GetChatModelsResult>("get_chat_models");
}

export async function testChatProvider(
  input: TestChatProviderInput
): Promise<TestChatProviderResult> {
  return invoke<TestChatProviderResult>("test_chat_provider", { input });
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

export async function getSearchObservability(
  input: SearchObservabilityInput
): Promise<
  SidecarEnvelope<SearchObservability>
> {
  return invoke<SidecarEnvelope<SearchObservability>>("get_search_observability", {
    input,
  });
}

export async function getNodeIndexingStatus(
  nodeId: string
): Promise<SidecarEnvelope<NodeIndexStatus>> {
  return invoke<SidecarEnvelope<NodeIndexStatus>>("get_node_indexing_status", {
    input: { nodeId },
  });
}

/**
 * Pulls the indexed text the sidecar holds for a single node — used
 * by the image preview surface to render OCR + caption as markdown
 * in the center pane. Returns ``state: "ready"`` with empty chunks
 * for un-indexed nodes (image with no extractors wired, fresh
 * upload before the runner drains).
 */
export async function getNodeContent(
  nodeId: string
): Promise<SidecarEnvelope<NodeContent>> {
  return invoke<SidecarEnvelope<NodeContent>>("get_node_content", {
    input: { nodeId },
  });
}

export async function getModelsStatus(): Promise<SidecarEnvelope<ModelsStatus>> {
  return invoke<SidecarEnvelope<ModelsStatus>>("get_models_status");
}

/**
 * Kick off a sidecar-side model download. The Rust command
 * subscribes to the SSE stream and re-emits each frame as a Tauri
 * event named `models/progress` (use `useModelDownloadProgress` to
 * subscribe). Resolves when the stream closes; rejects on setup-time
 * failures (sidecar offline).
 */
export async function startModelDownload(
  input: StartModelDownloadInput
): Promise<void> {
  return invoke<void>("start_model_download", { input });
}

export async function getSearchSettings(): Promise<
  SidecarEnvelope<SearchSettings>
> {
  return invoke<SidecarEnvelope<SearchSettings>>("get_search_settings");
}

export async function updateSearchSettings(
  settings: SearchSettings
): Promise<SidecarEnvelope<SearchSettings>> {
  return invoke<SidecarEnvelope<SearchSettings>>("update_search_settings", {
    settings,
  });
}

export async function readSearchSettingsFallback(): Promise<SearchSettings> {
  return invoke<SearchSettings>("read_search_settings_fallback");
}

export async function restartSidecar(): Promise<void> {
  return invoke<void>("restart_sidecar");
}

export async function setProviderSecret(
  input: SetProviderSecretInput
): Promise<void> {
  return invoke<void>("set_provider_secret", { input });
}

export async function getProviderSecretPresent(
  input: ProviderSecretLookupInput
): Promise<boolean> {
  return invoke<boolean>("get_provider_secret_present", { input });
}

export async function deleteProviderSecret(
  input: ProviderSecretLookupInput
): Promise<void> {
  return invoke<void>("delete_provider_secret", { input });
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
