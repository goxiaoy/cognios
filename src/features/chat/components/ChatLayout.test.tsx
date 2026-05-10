import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatSessionDetail } from "../../../lib/contracts/chat";
import { ExplorerStoreProvider } from "../../explorer/store/ExplorerStoreContext";
import type { ExplorerClient } from "../../explorer/types/explorer";
import type { SearchClient } from "../../search/types/search";
import type { ChatClient } from "../api/chatClient";
import { ChatLayout } from "./ChatLayout";

function makeClient(): ChatClient {
  let sessionTitle = "New chat";
  return {
    createSession: vi.fn().mockImplementation(async (input) => {
      sessionTitle = input?.title ?? "New chat";
      return {
        id: "s1",
        title: sessionTitle,
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      };
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockImplementation(async ({ sessionId }) => ({
      session: {
        id: sessionId,
        title: sessionTitle,
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      },
      messages: [],
      clusters: [],
    })),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    updateSessionTitle: vi.fn().mockImplementation(async ({ sessionId, title }) => {
      sessionTitle = title;
      return {
        id: sessionId,
        title,
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      };
    }),
    appendMessage: vi.fn(),
    recordCluster: vi.fn(),
    bindNote: vi.fn(),
    getModels: vi.fn().mockResolvedValue({
      models: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [
            { id: "llama3.2", name: "llama3.2" },
            { id: "qwen2.5:7b", name: "qwen2.5:7b" },
          ],
          cached: false,
          warnings: [],
        },
      },
    }),
    startTurn: vi.fn().mockResolvedValue({
      turn: {
        state: "ready",
        data: {
          state: "ready",
          clusters: [
            {
              clusterId: "workspace:事故/照片",
              title: "事故/照片",
              sourceKind: "workspace",
              status: "candidate",
              summary: "2 workspace source(s) clustered by path and relevance.",
              score: 0.9,
              sources: [],
            },
          ],
          answer: "事故发生在 3 月 1 日。",
          citations: [],
          warnings: [],
        },
      },
    }),
  };
}

function makeSearchClient(): SearchClient {
  return {
    search: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        results: [
          {
            nodeId: "n1",
            kind: "note",
            name: "事故报告",
            score: 0.91,
            snippet: "3 月 1 日事故现场记录",
            matchedIn: "content",
            path: "事故/报告.md",
          },
        ],
        degraded: false,
        nextCursor: null,
      },
    }),
    indexStatus: vi.fn(),
    nodeIndexStatus: vi.fn(),
    nodeContent: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        nodeId: "n1",
        kind: "note",
        chunks: [{ id: "c1", role: "body", text: "完整事故报告内容" }],
        joined: "完整事故报告内容",
        assets: {},
      },
    }),
    modelsStatus: vi.fn(),
    startModelDownload: vi.fn(),
    settings: vi.fn(),
    updateSettings: vi.fn(),
    restartSidecar: vi.fn(),
    readSettingsFallback: vi.fn(),
    setProviderSecret: vi.fn(),
    hasProviderSecret: vi.fn(),
    deleteProviderSecret: vi.fn(),
    testChatProvider: vi.fn(),
  };
}

function makeExplorerClient(): ExplorerClient {
  return {
    getExplorerSnapshot: vi.fn().mockResolvedValue({ roots: [] }),
    getMountSetupContext: vi.fn().mockResolvedValue({ suggestedFolders: [], existingMounts: [] }),
    createFolder: vi.fn(),
    createMount: vi.fn(),
    createNote: vi.fn(),
    createUrl: vi.fn(),
    renameNode: vi.fn(),
    deleteNode: vi.fn(),
    reindexNode: vi.fn(),
    retryUrl: vi.fn(),
    getNodeThumbnail: vi.fn(),
    getNoteContent: vi.fn(),
    saveNoteContent: vi.fn(),
    readFileContent: vi.fn(),
    showNodeInFileManager: vi.fn(),
    showNodeExtractArtifacts: vi.fn(),
  };
}

describe("ChatLayout", () => {
  afterEach(() => {
    cleanup();
  });

  it("sends a prompt directly and shows the assistant response", async () => {
    const client = makeClient();
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    expect(await screen.findByLabelText(/model/i)).toHaveValue("llama3.2");
    expect(screen.queryByRole("button", { name: /Synthesize/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    expect(await screen.findByText(/3 月 1 日/)).toBeInTheDocument();
    expect(client.startTurn).toHaveBeenCalledWith({
      sessionId: "s1",
      query: "整理事故时间线",
      model: "llama3.2",
      includeWeb: true,
      contextNodes: [],
    });
    expect(client.createSession).toHaveBeenCalledWith({ title: "整理事故时间线" });
  });

  it("retitles an empty default session from the first question", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "New chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "这次事故的费用和责任怎么判断？" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.updateSessionTitle).toHaveBeenCalledWith({
        sessionId: "s1",
        title: "这次事故的费用和责任怎么判断",
      });
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("does not leave an empty active session to create another chat", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "New chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    await waitFor(() => {
      expect(client.getSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.updateSessionTitle).toHaveBeenCalledWith({
        sessionId: "s1",
        title: "整理事故时间线",
      });
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("uses the model selected in chat for the next turn", async () => {
    const client = makeClient();
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.change(await screen.findByLabelText(/model/i), {
      target: { value: "qwen2.5:7b" },
    });
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        model: "qwen2.5:7b",
        includeWeb: true,
        contextNodes: [],
      });
    });
  });

  it("adds a searched node as context for the next message", async () => {
    const client = makeClient();
    const searchClient = makeSearchClient();
    render(
      <ExplorerStoreProvider client={makeExplorerClient()}>
        <ChatLayout client={client} searchClient={searchClient} />
      </ExplorerStoreProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.change(screen.getByPlaceholderText(/Search notes/i), {
      target: { value: "事故报告" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /事故报告/ }));
    await waitFor(() => {
      expect(searchClient.nodeContent).toHaveBeenCalledWith("n1");
    });
    expect(await screen.findByText(/1 context/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        model: "llama3.2",
        includeWeb: true,
        contextNodes: [
          {
            nodeId: "n1",
            title: "事故报告",
            kind: "note",
            path: "事故/报告.md",
            snippet: "3 月 1 日事故现场记录",
            content: "完整事故报告内容",
          },
        ],
      });
    });
  });

  it("uses the mount icon for a mount added as context", async () => {
    const client = makeClient();
    const searchClient = makeSearchClient();
    vi.mocked(searchClient.search).mockResolvedValue({
      state: "ready",
      data: {
        results: [
          {
            nodeId: "mount-1",
            kind: "mount",
            name: "20260301",
            score: 0.94,
            snippet: "事故资料目录",
            matchedIn: "name",
            path: "/incidents/20260301",
          },
        ],
        degraded: false,
        nextCursor: null,
      },
    });
    vi.mocked(searchClient.nodeContent).mockResolvedValue({
      state: "ready",
      data: {
        nodeId: "mount-1",
        kind: "mount",
        chunks: [],
        joined: "",
        assets: {},
      },
    });

    render(
      <ExplorerStoreProvider client={makeExplorerClient()}>
        <ChatLayout client={client} searchClient={searchClient} />
      </ExplorerStoreProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.change(screen.getByPlaceholderText(/Search notes/i), {
      target: { value: "20260301" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /20260301/ }));

    const chip = (await screen.findByText("20260301")).closest(".chat-context-chip");
    expect(chip?.querySelector(".lucide-hard-drive")).not.toBeNull();
    expect(chip?.querySelector(".lucide-file-text")).toBeNull();
  });

  it("does not duplicate a freshly persisted assistant answer", async () => {
    const client = makeClient();
    const emptyDetail: ChatSessionDetail = {
      session: {
        id: "s1",
        title: "Research chat",
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      },
      messages: [],
      clusters: [],
    };
    vi.mocked(client.getSession)
      .mockResolvedValueOnce(emptyDetail)
      .mockResolvedValueOnce(emptyDetail)
      .mockResolvedValueOnce({
        ...emptyDetail,
        messages: [
          {
            id: "m2",
            sessionId: "s1",
            role: "assistant",
            body: "事故发生在 3 月 1 日。",
            ordinal: 1,
            metadataJson: "{}",
            createdAt: "now",
          },
        ],
      });
    vi.mocked(client.startTurn).mockResolvedValueOnce({
      turn: {
        state: "ready",
        data: {
          state: "ready",
          clusters: [],
          answer: "事故发生在 3 月 1 日。",
          citations: [],
          warnings: [],
        },
      },
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getAllByText("事故发生在 3 月 1 日。")).toHaveLength(1);
    });
  });

  it("deletes the active session and clears the chat when none remain", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "Research chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions)
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    expect(screen.queryByRole("button", { name: /Delete chat Research chat/i })).not.toBeInTheDocument();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Research chat" }), {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() => {
      expect(client.deleteSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(await screen.findByText("No chats yet")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument();
  });

  it("selects the next session after deleting the active session", async () => {
    const client = makeClient();
    const first = {
      id: "s1",
      title: "First chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    const second = {
      id: "s2",
      title: "Second chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    vi.mocked(client.getSession).mockImplementation(async ({ sessionId }) => ({
      session: sessionId === "s2" ? second : first,
      messages: [],
      clusters: [],
    }));

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "First chat" }), {
      clientX: 120,
      clientY: 160,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() => {
      expect(client.deleteSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(await screen.findByRole("heading", { name: "Second chat" })).toBeInTheDocument();
  });
});
