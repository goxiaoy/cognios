import {
  appendChatMessage,
  bindChatNote,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  recordChatCluster,
  startChatTurn,
} from "../../../lib/tauri/ipc";
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
  RecordChatClusterInput,
  StartChatTurnInput,
  StartChatTurnResult,
} from "../../../lib/contracts/chat";

export interface ChatClient {
  createSession(input?: CreateChatSessionInput): Promise<ChatSession>;
  listSessions(): Promise<ChatSession[]>;
  getSession(input: ChatSessionInput): Promise<ChatSessionDetail>;
  deleteSession(input: ChatSessionInput): Promise<DeleteChatSessionResult>;
  appendMessage(input: AppendChatMessageInput): Promise<ChatMessage>;
  recordCluster(input: RecordChatClusterInput): Promise<ChatSourceCluster>;
  bindNote(input: BindChatNoteInput): Promise<ChatSession>;
  startTurn(input: StartChatTurnInput): Promise<StartChatTurnResult>;
}

export const chatClient: ChatClient = {
  createSession: createChatSession,
  listSessions: listChatSessions,
  getSession: getChatSession,
  deleteSession: deleteChatSession,
  appendMessage: appendChatMessage,
  recordCluster: recordChatCluster,
  bindNote: bindChatNote,
  startTurn: startChatTurn,
};
