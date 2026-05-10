import {
  appendChatMessage,
  bindChatNote,
  createChatSession,
  deleteChatSession,
  exportChatSessionMemory,
  getChatModels,
  getChatSession,
  getChatSessionMemory,
  listChatSessions,
  recordChatCluster,
  startChatTurn,
  triggerChatSessionMemoryOpportunity,
  updateChatSessionTitle,
} from "../../../lib/tauri/ipc";
import type {
  AppendChatMessageInput,
  BindChatNoteInput,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatSessionInput,
  ChatSourceCluster,
  ExportChatSessionMemoryResult,
  GetChatSessionMemoryResult,
  GetChatModelsResult,
  CreateChatSessionInput,
  DeleteChatSessionResult,
  RecordChatClusterInput,
  StartChatTurnInput,
  StartChatTurnResult,
  TriggerChatSessionMemoryOpportunityInput,
  UpdateChatSessionTitleInput,
} from "../../../lib/contracts/chat";

export interface ChatClient {
  createSession(input?: CreateChatSessionInput): Promise<ChatSession>;
  listSessions(): Promise<ChatSession[]>;
  getSession(input: ChatSessionInput): Promise<ChatSessionDetail>;
  deleteSession(input: ChatSessionInput): Promise<DeleteChatSessionResult>;
  updateSessionTitle(input: UpdateChatSessionTitleInput): Promise<ChatSession>;
  getSessionMemory(input: ChatSessionInput): Promise<GetChatSessionMemoryResult>;
  exportSessionMemory(input: ChatSessionInput): Promise<ExportChatSessionMemoryResult>;
  triggerMemoryOpportunity(input: TriggerChatSessionMemoryOpportunityInput): Promise<void>;
  appendMessage(input: AppendChatMessageInput): Promise<ChatMessage>;
  recordCluster(input: RecordChatClusterInput): Promise<ChatSourceCluster>;
  bindNote(input: BindChatNoteInput): Promise<ChatSession>;
  startTurn(input: StartChatTurnInput): Promise<StartChatTurnResult>;
  getModels(): Promise<GetChatModelsResult>;
}

export const chatClient: ChatClient = {
  createSession: createChatSession,
  listSessions: listChatSessions,
  getSession: getChatSession,
  deleteSession: deleteChatSession,
  updateSessionTitle: updateChatSessionTitle,
  getSessionMemory: getChatSessionMemory,
  exportSessionMemory: exportChatSessionMemory,
  triggerMemoryOpportunity: triggerChatSessionMemoryOpportunity,
  appendMessage: appendChatMessage,
  recordCluster: recordChatCluster,
  bindNote: bindChatNote,
  startTurn: startChatTurn,
  getModels: getChatModels,
};
