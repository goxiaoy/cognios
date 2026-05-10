import {
  appendChatMessage,
  bindChatNote,
  createChatSession,
  deleteChatSession,
  getChatModels,
  getChatSession,
  listChatSessions,
  recordChatCluster,
  startChatTurn,
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
  GetChatModelsResult,
  CreateChatSessionInput,
  DeleteChatSessionResult,
  RecordChatClusterInput,
  StartChatTurnInput,
  StartChatTurnResult,
  UpdateChatSessionTitleInput,
} from "../../../lib/contracts/chat";

export interface ChatClient {
  createSession(input?: CreateChatSessionInput): Promise<ChatSession>;
  listSessions(): Promise<ChatSession[]>;
  getSession(input: ChatSessionInput): Promise<ChatSessionDetail>;
  deleteSession(input: ChatSessionInput): Promise<DeleteChatSessionResult>;
  updateSessionTitle(input: UpdateChatSessionTitleInput): Promise<ChatSession>;
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
  appendMessage: appendChatMessage,
  recordCluster: recordChatCluster,
  bindNote: bindChatNote,
  startTurn: startChatTurn,
  getModels: getChatModels,
};
