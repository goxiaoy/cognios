import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChatSessionDetail,
  ChatSessionMemoryEventPayload,
  ChatTurnStreamPayload,
} from "../../../lib/contracts/chat";
import type { RealtimeVoiceEvent } from "../../../lib/contracts/realtimeVoice";
import {
  ExplorerStoreProvider,
  useExplorerStoreContext,
} from "../../explorer/store/ExplorerStoreContext";
import type { ExplorerClient, ExplorerSnapshot } from "../../explorer/types/explorer";
import type { SearchSettings } from "../../../lib/contracts/search";
import type { SearchClient } from "../../search/types/search";
import type { ChatClient } from "../api/chatClient";
import { ChatLayout } from "./ChatLayout";

type ChatTurnListener = (event: { payload: ChatTurnStreamPayload }) => void;
type ChatMemoryListener = (event: { payload: ChatSessionMemoryEventPayload }) => void;
type RealtimeVoiceListener = (event: { payload: RealtimeVoiceEvent }) => void;

const eventMock = vi.hoisted(() => ({
  chatTurnListener: null as ChatTurnListener | null,
  chatMemoryListener: null as ChatMemoryListener | null,
  realtimeVoiceListener: null as RealtimeVoiceListener | null,
  unlisten: vi.fn(),
}));
const scrollIntoViewMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: ChatTurnListener | ChatMemoryListener | RealtimeVoiceListener) => {
    if (name === "chat/turn") eventMock.chatTurnListener = cb as ChatTurnListener;
    if (name === "chat/session-memory") eventMock.chatMemoryListener = cb as ChatMemoryListener;
    if (name === "realtime-voice/event") eventMock.realtimeVoiceListener = cb as RealtimeVoiceListener;
    return eventMock.unlisten;
  }),
}));

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
    getSessionMemory: vi.fn().mockResolvedValue({ available: false }),
    exportSessionMemory: vi.fn().mockResolvedValue({
      noteId: "note-1",
      snapshot: { roots: [] },
    }),
    triggerMemoryOpportunity: vi.fn().mockResolvedValue(undefined),
    getRealtimeVoiceStatus: vi.fn().mockResolvedValue({
      status: {
        state: "ready",
        data: {
          status: "unavailable",
          available: false,
          local: true,
          provider: "qwen3-asr-vllm",
          reason: "Local realtime ASR runtime is not packaged with this build.",
          packaging: "missing",
          runtimePath: null,
          websocketUrl: null,
        },
      },
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

function makeSearchSettings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  const base: SearchSettings = {
    version: 1,
    providers: {
      "local-ollama": {
        providerId: "local-ollama",
        enabled: true,
        apiKeyRef: null,
        baseUrl: "http://127.0.0.1:11434",
        modelPerCapability: {},
      },
    },
    features: {
      llm: { enabled: true, providerId: "local-ollama" },
    },
    cloudConsentAcked: [],
    firstRunSkipped: false,
    needsRestart: false,
  };
  return { ...base, ...overrides };
}

function makeSearchClient(settings = makeSearchSettings()): SearchClient {
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
    indexStatistics: vi.fn().mockResolvedValue({ recentIndexedNodes: [] }),
    observability: vi.fn(),
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
    settings: vi.fn().mockResolvedValue({
      state: "ready",
      data: settings,
    }),
    updateSettings: vi.fn().mockImplementation(async (next: SearchSettings) => ({
      state: "ready",
      data: { ...next, needsRestart: false },
    })),
    restartSidecar: vi.fn(),
    readSettingsFallback: vi.fn().mockResolvedValue(settings),
    setProviderSecret: vi.fn(),
    hasProviderSecret: vi.fn(),
    deleteProviderSecret: vi.fn(),
    testChatProvider: vi.fn().mockResolvedValue({
      result: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [{ id: "llama3.2", name: "llama3.2" }],
          cached: false,
          warnings: [],
        },
      },
    }),
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

function mockRealtimeVoiceReady(client: ChatClient) {
  vi.mocked(client.getRealtimeVoiceStatus).mockResolvedValue({
    status: {
      state: "ready",
      data: {
        status: "ready",
        available: true,
        local: true,
        provider: "qwen3-asr-vllm",
        reason: "Development realtime ASR runtime is explicitly enabled.",
        packaging: "supported",
        runtimePath: "/tmp/realtime-asr",
        websocketUrl: "ws://127.0.0.1:9000/v1/realtime",
      },
    },
  });
}

async function readyComposer(): Promise<HTMLTextAreaElement> {
  const composer = (await screen.findByLabelText("Chat message")) as HTMLTextAreaElement;
  await waitFor(() => {
    expect(composer).not.toBeDisabled();
  });
  return composer;
}

function ExplorerSnapshotProbe({ snapshot }: { snapshot: ExplorerSnapshot }) {
  const store = useExplorerStoreContext();

  useEffect(() => {
    store.applySnapshot(snapshot);
  }, [snapshot]);

  return <output aria-label="Selected source">{store.selectedArtifactIds.join(",")}</output>;
}

describe("ChatLayout", () => {
  beforeEach(() => {
    scrollIntoViewMock.mockReset();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    eventMock.chatTurnListener = null;
    eventMock.realtimeVoiceListener = null;
    eventMock.unlisten.mockReset();
  });

  it("shows realtime voice as unavailable until the local runtime is ready", async () => {
    render(<ChatLayout client={makeClient()} searchClient={makeSearchClient()} />);

    const voiceButton = await screen.findByRole("button", { name: /local realtime asr runtime/i });

    expect(voiceButton).toHaveTextContent("Voice");
    expect(voiceButton).toBeDisabled();
  });

  it("retries realtime voice status while the sidecar is initialising", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.mocked(client.getRealtimeVoiceStatus)
      .mockResolvedValueOnce({ status: { state: "initialising" } })
      .mockResolvedValueOnce({
        status: {
          state: "ready",
          data: {
            status: "unavailable",
            available: false,
            local: true,
            provider: "qwen3-asr-vllm",
            reason: "Local realtime ASR runtime is not packaged with this build.",
            packaging: "missing",
            runtimePath: null,
            websocketUrl: null,
          },
        },
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getRealtimeVoiceStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(client.getRealtimeVoiceStatus).toHaveBeenCalledTimes(2);
  });

  it("does not send provisional realtime voice captions to the LLM", async () => {
    const client = makeClient();
    mockRealtimeVoiceReady(client);
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    await screen.findByRole("button", { name: /start realtime voice chat/i });
    expect(eventMock.realtimeVoiceListener).toBeTruthy();

    await act(async () => {
      eventMock.realtimeVoiceListener?.({
        payload: {
          kind: "provisional_caption",
          sessionId: "voice-session-1",
          text: "partial words",
          sequence: 1,
        },
      });
    });

    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("submits finalized realtime voice utterances through the existing chat turn", async () => {
    const client = makeClient();
    mockRealtimeVoiceReady(client);
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    await readyComposer();
    await screen.findByRole("button", { name: /start realtime voice chat/i });

    await act(async () => {
      eventMock.realtimeVoiceListener?.({
        payload: {
          kind: "final_utterance",
          sessionId: "voice-session-1",
          text: "  summarize the meeting  ",
          sequence: 2,
        },
      });
    });

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "summarize the meeting",
        turnEventId: expect.any(String),
        model: "llama3.2",
        includeWeb: true,
        contextNodes: [],
      });
    });
  });

  it("sends a prompt with Enter and shows the submitted prompt in the transcript", async () => {
    const client = makeClient();
    const createdSession = {
      id: "s1",
      title: "整理事故时间线",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValueOnce([]).mockResolvedValue([createdSession]);
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    expect(screen.queryByRole("complementary", { name: /chat sessions/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Web$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Workspace \+ web/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Web search enabled")).not.toBeInTheDocument();
    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    expect(await screen.findByRole("button", { name: /model: llama3\.2/i })).toBeInTheDocument();
    expect(
      within(screen.getByRole("form", { name: /chat composer/i })).getByRole("button", {
        name: /model: llama3\.2/i,
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Synthesize/i })).not.toBeInTheDocument();
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        turnEventId: expect.any(String),
        model: "llama3.2",
        includeWeb: true,
        contextNodes: [],
      });
    });
    await waitFor(() => {
      expect(composer).toHaveValue("");
    });
    const sentMessage = screen
      .getAllByText("整理事故时间线")
      .find((node) => node.closest(".chat-message.is-user"));
    expect(sentMessage).toBeTruthy();
    expect(await screen.findByText(/3 月 1 日/)).toBeInTheDocument();
    expect(sentMessage?.closest(".chat-message.is-user")?.querySelector(".chat-message-role")).toBeNull();
    expect(screen.getByText(/3 月 1 日/).closest(".chat-message.is-assistant")?.querySelector(".chat-message-role")).toBeNull();
    expect(client.createSession).toHaveBeenCalledWith({ title: "整理事故时间线" });
    expect(await screen.findByRole("complementary", { name: /chat sessions/i })).toBeInTheDocument();
  });

  it("sorts unsupported agentic models last and disables them with a reason", async () => {
    const client = makeClient();
    vi.mocked(client.getModels).mockResolvedValue({
      models: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [
            {
              id: "gemma3:4b",
              name: "gemma3:4b",
              supportsAgentic: false,
              unavailableReason: "This Ollama model does not support tools.",
            },
            { id: "qwen3:4b", name: "qwen3:4b", supportsAgentic: true },
          ],
          cached: false,
          warnings: [],
        },
      },
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const picker = await screen.findByRole("button", { name: /model: qwen3:4b/i });
    fireEvent.click(picker);
    const options = screen.getAllByRole("option");

    expect(options[0]).toHaveTextContent("qwen3:4b");
    expect(options[1]).toHaveTextContent("gemma3:4b");
    expect(options[1]).toHaveAttribute("aria-disabled", "true");
    expect(options[1]).toHaveTextContent("This Ollama model does not support tools.");
  });

  it("loads chat history on startup without selecting an old session", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const sidebar = await screen.findByRole("complementary", { name: /chat sessions/i });
    expect(within(sidebar).getByRole("button", { name: "事故复盘" })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("heading", { name: "Chats" })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "Start new chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument();
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("focuses the composer when Chat becomes visible", async () => {
    const client = makeClient();
    const searchClient = makeSearchClient();
    const { rerender } = render(
      <ChatLayout client={client} searchClient={searchClient} visible={false} />
    );

    rerender(<ChatLayout client={client} searchClient={searchClient} visible />);

    await waitFor(() => {
      expect(screen.getByLabelText("Chat message")).toHaveFocus();
    });
  });

  it("renders context nodes saved on historical user messages", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [
        {
          id: "m1",
          sessionId: "s1",
          role: "user",
          body: "这次事故怎么发生的？",
          ordinal: 0,
          metadataJson: JSON.stringify({
            stage: "submitted",
            contextNodes: [
              {
                nodeId: "n1",
                title: "事故报告",
                kind: "note",
                path: "事故/报告.md",
              },
            ],
          }),
          createdAt: "now",
        },
      ],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));
    const message = (await screen.findByText("这次事故怎么发生的？")).closest(".chat-message");
    expect(message).not.toBeNull();
    const attachedContext = within(message as HTMLElement).getByLabelText("Attached context");
    const messageBody = within(message as HTMLElement).getByText("这次事故怎么发生的？");
    expect(attachedContext).toBeInTheDocument();
    expect(within(message as HTMLElement).getByText("事故报告")).toBeInTheDocument();
    expect(attachedContext.compareDocumentPosition(messageBody) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a web search icon beside the model picker when web search is enabled", async () => {
    const settings = makeSearchSettings();
    settings.providers["brave-search"] = {
      providerId: "brave-search",
      enabled: true,
      apiKeyRef: "env-file://cogios/.env#brave-search",
      baseUrl: "https://api.search.brave.com/res/v1",
      modelPerCapability: { "web-search": "brave-web" },
    };
    settings.features["web-search"] = {
      enabled: true,
      providerId: "brave-search",
    };

    render(<ChatLayout client={makeClient()} searchClient={makeSearchClient(settings)} />);

    await readyComposer();
    const indicator = screen.getByLabelText("Web search enabled");
    const modelGroup = indicator.closest(".chat-composer-meta-group");
    expect(modelGroup).not.toBeNull();
    expect(
      within(modelGroup as HTMLElement).getByRole("button", { name: /model: llama3\.2/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Workspace \+ web/i)).not.toBeInTheDocument();
  });

  it("keeps Shift Enter available for multiline drafting", async () => {
    const client = makeClient();
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "第一行" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: true });

    expect(client.startTurn).not.toHaveBeenCalled();
    expect(composer).toHaveValue("第一行");
  });

  it("updates the assistant answer from chat stream events", async () => {
    const client = makeClient();
    let resolveTurn: ((value: Awaited<ReturnType<ChatClient["startTurn"]>>) => void) | null = null;
    vi.mocked(client.startTurn).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        })
    );
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalled();
      expect(eventMock.chatTurnListener).not.toBeNull();
    });
    const turnEventId = vi.mocked(client.startTurn).mock.calls[0][0].turnEventId!;
    expect(await screen.findByText("Thinking")).toBeInTheDocument();

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: { event: "delta", delta: "事故发生在 " },
        },
      });
    });
    expect(screen.getByText("事故发生在")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: { event: "delta", delta: "3 月 1 日。" },
        },
      });
    });
    expect(screen.getByText("事故发生在 3 月 1 日。")).toBeInTheDocument();

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: {
            event: "tool",
            toolEvents: [
              {
                toolName: "grep_workspace",
                status: "running",
                summary: "Searching workspace for '事故'.",
              },
            ],
          },
        },
      });
    });
    expect(screen.getByText("Searching workspace for '事故'.")).toBeInTheDocument();

    act(() => {
      resolveTurn!({
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
    });
    await waitFor(() => {
      expect(client.listSessions).toHaveBeenCalledTimes(2);
    });
  });

  it("shows tool activity before the assistant streams text", async () => {
    const client = makeClient();
    vi.mocked(client.startTurn).mockImplementationOnce(
      async () =>
        new Promise(() => {
          // Keep the turn pending so the UI must render streamed tool events during loading.
        })
    );
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "查一下事故" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalled();
      expect(eventMock.chatTurnListener).not.toBeNull();
    });
    const turnEventId = vi.mocked(client.startTurn).mock.calls[0][0].turnEventId!;

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: {
            event: "tool",
            toolEvents: [
              {
                toolName: "grep_workspace",
                status: "running",
                summary: "Searching workspace for '事故'.",
              },
            ],
          },
        },
      });
    });

    expect(screen.getByText("Searching workspace for '事故'.")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("renders assistant replies as markdown", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [
        {
          id: "m1",
          sessionId: "s1",
          role: "user",
          body: "**这个不应该加粗**",
          ordinal: 0,
          metadataJson: "{}",
          createdAt: "now",
        },
        {
          id: "m2",
          sessionId: "s1",
          role: "assistant",
          body: "### 事故时间线\n\n- **3 月 1 日**：事故发生\n\n<script>alert('x')</script>",
          ordinal: 1,
          metadataJson: "{}",
          createdAt: "now",
        },
      ],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));

    expect(await screen.findByRole("heading", { name: "事故时间线", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("3 月 1 日")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText(/事故发生/).closest("li")).toBeInTheDocument();
    expect(screen.getByText("**这个不应该加粗**")).toBeInTheDocument();
    expect(document.querySelector(".chat-message.is-user strong")).toBeNull();
    expect(document.querySelector(".chat-message.is-assistant script")).toBeNull();
  });

  it("renders assistant citations as inline badges", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [
        {
          id: "m1",
          sessionId: "s1",
          role: "assistant",
          body: "金额为 **1,383.00 元** [W3][W8]。\n\n`[W9]`",
          ordinal: 0,
          metadataJson: JSON.stringify({
            citations: [
              {
                marker: "W3",
                label: "住院.pdf",
                nodeId: "n-w3",
                citation: "n-w3",
                title: "住院费用清单",
                sourceKind: "workspace",
                path: "费用/住院.pdf",
              },
              {
                marker: "W8",
                label: "发票.jpg",
                nodeId: "n-w8",
                citation: "n-w8",
                title: "发票照片",
                sourceKind: "workspace",
                path: "照片/发票.jpg",
              },
            ],
          }),
          createdAt: "now",
        },
      ],
      clusters: [],
    });
    const snapshot: ExplorerSnapshot = {
      roots: [
        {
          id: "n-w3",
          parentId: null,
          name: "住院费用清单.md",
          kind: "note",
          state: "ready",
          createdAt: "now",
          modifiedAt: "now",
          sizeBytes: 0,
          children: [],
        },
        {
          id: "n-w8",
          parentId: null,
          name: "发票照片.jpg",
          kind: "file",
          state: "indexed",
          createdAt: "now",
          modifiedAt: "now",
          sizeBytes: 0,
          children: [],
        },
      ],
    };
    const onActivateSource = vi.fn();

    render(
      <ExplorerStoreProvider client={makeExplorerClient()}>
        <ExplorerSnapshotProbe snapshot={snapshot} />
        <ChatLayout
          client={client}
          searchClient={makeSearchClient()}
          onActivateSource={onActivateSource}
        />
      </ExplorerStoreProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));

    const w3 = await screen.findByRole("link", { name: "Citation W3: 住院.pdf" });
    expect(w3).toHaveClass("chat-inline-citation");
    expect(w3).toHaveAttribute("href", "#citation-W3");
    expect(w3).toHaveAttribute("title", "住院.pdf - 费用/住院.pdf");
    expect(w3).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: "Citation W8: 发票.jpg" })).toHaveTextContent("8");
    expect(screen.queryByLabelText("Sources")).not.toBeInTheDocument();
    fireEvent.click(w3);
    expect(screen.getByLabelText("Selected source")).toHaveTextContent("n-w3");
    expect(onActivateSource).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: /Citation W9/ })).not.toBeInTheDocument();
    expect(screen.getByText("[W9]")).toHaveProperty("tagName", "CODE");
  });

  it("opens an attached chat context file in Explorer", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [
        {
          id: "m1",
          sessionId: "s1",
          role: "user",
          body: "讲了啥",
          ordinal: 0,
          metadataJson: JSON.stringify({
            contextNodes: [
              {
                nodeId: "file-1",
                title: "事故报告.md",
                kind: "file",
                path: "事故/事故报告.md",
              },
            ],
          }),
          createdAt: "now",
        },
      ],
      clusters: [],
    });
    const snapshot: ExplorerSnapshot = {
      roots: [
        {
          id: "file-1",
          parentId: null,
          name: "事故报告.md",
          kind: "file",
          state: "indexed",
          createdAt: "now",
          modifiedAt: "now",
          sizeBytes: 0,
          children: [],
        },
      ],
    };
    const onActivateSource = vi.fn();

    render(
      <ExplorerStoreProvider client={makeExplorerClient()}>
        <ExplorerSnapshotProbe snapshot={snapshot} />
        <ChatLayout
          client={client}
          searchClient={makeSearchClient()}
          onActivateSource={onActivateSource}
        />
      </ExplorerStoreProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));

    const contextButton = await screen.findByRole("button", {
      name: "Open context 事故报告.md",
    });
    expect(contextButton).toHaveClass("chat-message-context-chip");
    expect(contextButton).toHaveAttribute("title", "事故/事故报告.md");

    fireEvent.click(contextButton);

    expect(screen.getByLabelText("Selected source")).toHaveTextContent("file-1");
    expect(onActivateSource).toHaveBeenCalledOnce();
  });

  it("opens read-only Session Memory and exports a Note snapshot", async () => {
    const client = makeClient();
    const session = {
      id: "s1",
      title: "事故复盘",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    };
    vi.mocked(client.listSessions).mockResolvedValue([session]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [],
      clusters: [],
      memory: {
        available: true,
        status: "ready",
        revision: 2,
        lastSuccessfulRevision: 2,
        lastIncludedMessageOrdinal: 5,
        providerId: "local-ollama",
        modelId: "qwen2.5:7b",
        updatedAt: "now",
      },
    });
    vi.mocked(client.getSessionMemory).mockResolvedValue({
      available: true,
      body: "```markdown\n## Timeline\n\n<script>alert('x')</script>\n\n- **3 月 1 日**：事故发生\n```",
      revision: 2,
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.click(await screen.findByRole("button", { name: "事故复盘" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Session Memory" }));

    expect(await screen.findByRole("heading", { name: "Session Memory" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Timeline", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("3 月 1 日")).toHaveProperty("tagName", "STRONG");
    expect(document.querySelector(".chat-memory-markdown pre")).toBeNull();
    expect(document.querySelector(".chat-memory-panel script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save as Note" }));

    await waitFor(() => {
      expect(client.exportSessionMemory).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(await screen.findByText("Saved as editable Note snapshot.")).toBeInTheDocument();
  });

  it("scrolls to the latest chat content while a turn streams", async () => {
    const client = makeClient();
    let resolveTurn: ((value: Awaited<ReturnType<ChatClient["startTurn"]>>) => void) | null = null;
    vi.mocked(client.startTurn).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        })
    );
    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const composer = await readyComposer();
    await waitFor(() => {
      expect(eventMock.chatTurnListener).not.toBeNull();
    });
    scrollIntoViewMock.mockClear();

    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end", inline: "nearest" });
    });
    scrollIntoViewMock.mockClear();
    const turnEventId = vi.mocked(client.startTurn).mock.calls[0][0].turnEventId!;

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: { event: "delta", delta: "事故发生在 " },
        },
      });
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end", inline: "nearest" });
    });
    scrollIntoViewMock.mockClear();

    act(() => {
      eventMock.chatTurnListener!({
        payload: {
          turnEventId,
          event: { event: "delta", delta: "3 月 1 日。" },
        },
      });
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "end", inline: "nearest" });
    });

    act(() => {
      resolveTurn!({
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
    });
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

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    const composer = await readyComposer();
    fireEvent.change(composer, {
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

    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    await waitFor(() => {
      expect(client.getSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(screen.getByRole("button", { name: "Start new chat" })).toBeDisabled();

    const composer = await readyComposer();
    fireEvent.change(composer, {
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

    fireEvent.click(await screen.findByRole("button", { name: /model: llama3\.2/i }));
    fireEvent.click(screen.getByRole("option", { name: "qwen2.5:7b" }));
    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        turnEventId: expect.any(String),
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

    const composer = await readyComposer();
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.change(screen.getByPlaceholderText(/Search notes/i), {
      target: { value: "事故报告" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /事故报告/ }));
    await waitFor(() => {
      expect(searchClient.nodeContent).toHaveBeenCalledWith("n1");
    });
    const chip = (await screen.findByText("事故报告")).closest(".chat-context-chip");
    expect(chip).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove context 事故报告" })).toBeInTheDocument();

    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        turnEventId: expect.any(String),
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

  it("keeps long context titles available when the chip is truncated", async () => {
    const client = makeClient();
    const searchClient = makeSearchClient();
    const longTitle =
      "GitHub - adbar/trafilatura: Python & Command-Line tool to gather text from HTML";
    const longPath =
      "sources/research/2026/reference/github-adbar-trafilatura-python-command-line-tool-to-gather-text-from-html.md";
    vi.mocked(searchClient.search).mockResolvedValue({
      state: "ready",
      data: {
        results: [
          {
            nodeId: "long-file",
            kind: "file",
            name: longTitle,
            score: 0.92,
            snippet: "Long file title",
            matchedIn: "name",
            path: longPath,
          },
        ],
        degraded: false,
        nextCursor: null,
      },
    });
    vi.mocked(searchClient.nodeContent).mockResolvedValue({
      state: "ready",
      data: {
        nodeId: "long-file",
        kind: "file",
        chunks: [],
        joined: "Long file content",
        assets: {},
      },
    });

    render(
      <ExplorerStoreProvider client={makeExplorerClient()}>
        <ChatLayout client={client} searchClient={searchClient} />
      </ExplorerStoreProvider>
    );

    await readyComposer();
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.change(screen.getByPlaceholderText(/Search notes/i), {
      target: { value: "trafilatura" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /trafilatura/ }));

    const chip = (await screen.findByText(longTitle)).closest(".chat-context-chip");
    expect(chip).toHaveAttribute("title", longPath);
    expect(screen.getByRole("button", { name: `Remove context ${longTitle}` })).toBeInTheDocument();
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

    await readyComposer();
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
    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/i }));

    await waitFor(() => {
      expect(screen.getAllByText("事故发生在 3 月 1 日。")).toHaveLength(1);
    });
  });

  it("does not duplicate a freshly persisted user prompt", async () => {
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
      .mockResolvedValueOnce({
        ...emptyDetail,
        messages: [
          {
            id: "m1",
            sessionId: "s1",
            role: "user",
            body: "整理事故时间线",
            ordinal: 0,
            metadataJson: "{}",
            createdAt: "now",
          },
        ],
      });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);
    const composer = await readyComposer();
    fireEvent.change(composer, {
      target: { value: "整理事故时间线" },
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(client.getSession).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      const userMessages = screen
        .getAllByText("整理事故时间线")
        .filter((node) => node.closest(".chat-message.is-user"));
      expect(userMessages).toHaveLength(1);
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
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([]);
    vi.mocked(client.getSession).mockResolvedValue({
      session,
      messages: [],
      clusters: [],
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Research chat" }));
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
    expect(screen.queryByRole("complementary", { name: /chat sessions/i })).not.toBeInTheDocument();
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
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    vi.mocked(client.getSession).mockImplementation(async ({ sessionId }) => ({
      session: sessionId === "s2" ? second : first,
      messages: [],
      clusters: [],
    }));

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    fireEvent.click(await screen.findByRole("button", { name: "First chat" }));
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

  it("guides users to configure a chat provider outside the composer", async () => {
    const client = makeClient();
    vi.mocked(client.getModels).mockResolvedValue({
      models: {
        state: "ready",
        data: {
          state: "provider_unavailable",
          providerId: null,
          models: [],
          cached: false,
          warnings: ["No configured chat provider is ready."],
        },
      },
    });
    const settings = makeSearchSettings({
      providers: {},
      features: {
        llm: { enabled: false, providerId: null },
      },
    });
    const searchClient = makeSearchClient(settings);

    render(<ChatLayout client={client} searchClient={searchClient} />);

    expect(await screen.findByRole("heading", { name: /Set up LLM before sending/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Chat message")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /chat composer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Send$/i })).not.toBeInTheDocument();
    expect(screen.getByText("No configured chat provider is ready.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://127.0.0.1:11434" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => {
      expect(searchClient.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          providers: expect.objectContaining({
            "local-ollama": expect.objectContaining({
              providerId: "local-ollama",
              enabled: true,
              baseUrl: "http://127.0.0.1:11434",
            }),
          }),
          features: expect.objectContaining({
            llm: { enabled: true, providerId: "local-ollama" },
          }),
        })
      );
    });
    expect(screen.queryByRole("button", { name: /Remove/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(client.getModels).toHaveBeenCalledTimes(2);
    });
  });

  it("does not ask to set up LLM when built-in Ollama config exists but runtime is unavailable", async () => {
    const client = makeClient();
    vi.mocked(client.getModels).mockResolvedValue({
      models: {
        state: "ready",
        data: {
          state: "provider_unavailable",
          providerId: "local-ollama",
          models: [],
          cached: false,
          warnings: ["local-ollama: local runtime unreachable"],
        },
      },
    });

    render(<ChatLayout client={client} searchClient={makeSearchClient()} />);

    const composer = await screen.findByLabelText("Chat message");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "Waiting for chat provider...");
    expect(screen.getByText("local-ollama: local runtime unreachable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Set up LLM before sending/i })).not.toBeInTheDocument();
  });

  it("keeps a configured chat provider out of setup while startup model refresh recovers", async () => {
    const client = makeClient();
    vi.mocked(client.getModels)
      .mockResolvedValueOnce({
        models: {
          state: "ready",
          data: {
            state: "provider_unavailable",
            providerId: null,
            models: [],
            cached: false,
            warnings: ["chat provider unavailable"],
          },
        },
      })
      .mockResolvedValue({
        models: {
          state: "ready",
          data: {
            state: "ready",
            providerId: "deepseek",
            models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" }],
            cached: false,
            warnings: [],
          },
        },
      });
    const settings = makeSearchSettings({
      providers: {
        deepseek: {
          providerId: "deepseek",
          enabled: true,
          apiKeyRef: "env-file://cogios/.env#deepseek",
          baseUrl: null,
          modelPerCapability: {},
        },
      },
      features: {
        llm: { enabled: true, providerId: "deepseek" },
      },
    });
    const searchClient = makeSearchClient(settings);
    vi.mocked(searchClient.hasProviderSecret).mockResolvedValue(true);

    const { rerender } = render(
      <ChatLayout client={client} searchClient={searchClient} visible={true} />
    );

    const composer = await screen.findByLabelText("Chat message");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "Waiting for chat provider...");
    expect(screen.getByText("chat provider unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Set up LLM before sending/i })).not.toBeInTheDocument();

    rerender(<ChatLayout client={client} searchClient={searchClient} visible={false} />);
    rerender(<ChatLayout client={client} searchClient={searchClient} visible={true} />);

    expect(await screen.findByLabelText("Chat message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /model: deepseek-v4-flash/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Set up LLM before sending/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(client.getModels).toHaveBeenCalledTimes(2);
    });
  });

  it("does not present chat as the primary first action when the workspace is empty", async () => {
    render(
      <ChatLayout
        client={makeClient()}
        searchClient={makeSearchClient()}
        workspaceIsEmpty
      />
    );

    expect(
      await screen.findByRole("heading", { name: /Add content first/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Mount a folder, create a note, or record a voice note/i)
    ).toBeInTheDocument();
  });
});
