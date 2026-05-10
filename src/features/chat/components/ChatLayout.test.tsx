import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatSessionDetail } from "../../../lib/contracts/chat";
import type { ChatClient } from "../api/chatClient";
import { ChatLayout } from "./ChatLayout";

function makeClient(): ChatClient {
  return {
    createSession: vi.fn().mockResolvedValue({
      id: "s1",
      title: "Research chat",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    }),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({
      session: {
        id: "s1",
        title: "Research chat",
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      },
      messages: [],
      clusters: [],
    }),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
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
          state: "awaiting_source_confirmation",
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
          answer: null,
          citations: [],
          warnings: [],
        },
      },
    }),
  };
}

describe("ChatLayout", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows source clusters before synthesis", async () => {
    const client = makeClient();
    render(<ChatLayout client={client} />);

    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    expect(await screen.findByLabelText(/model/i)).toHaveValue("llama3.2");
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));

    expect(await screen.findByText("事故/照片")).toBeInTheDocument();
    expect(client.startTurn).toHaveBeenCalledWith({
      sessionId: "s1",
      query: "整理事故时间线",
      model: "llama3.2",
      includeWeb: true,
    });
  });

  it("uses the model selected in chat for the next turn", async () => {
    const client = makeClient();
    render(<ChatLayout client={client} />);

    fireEvent.change(await screen.findByLabelText(/model/i), {
      target: { value: "qwen2.5:7b" },
    });
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        model: "qwen2.5:7b",
        includeWeb: true,
      });
    });
  });

  it("synthesizes with the accepted cluster set", async () => {
    const client = makeClient();
    vi.mocked(client.startTurn)
      .mockResolvedValueOnce({
        turn: {
          state: "ready",
          data: {
            state: "awaiting_source_confirmation",
            clusters: [
              {
                clusterId: "workspace:事故/照片",
                title: "事故/照片",
                sourceKind: "workspace",
                status: "candidate",
                summary: "2 sources",
                score: 0.9,
                sources: [],
              },
            ],
            answer: null,
            citations: [],
            warnings: [],
          },
        },
      })
      .mockResolvedValueOnce({
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

    render(<ChatLayout client={client} />);
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
    fireEvent.click(await screen.findByText("事故/照片"));
    fireEvent.click(screen.getByRole("button", { name: /Synthesize/i }));

    await waitFor(() => {
      expect(client.startTurn).toHaveBeenLastCalledWith({
        sessionId: "s1",
        query: "整理事故时间线",
        model: "llama3.2",
        acceptedClusterIds: ["workspace:事故/照片"],
        includeWeb: true,
      });
    });
    expect(await screen.findByText(/3 月 1 日/)).toBeInTheDocument();
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
    vi.mocked(client.startTurn)
      .mockResolvedValueOnce({
        turn: {
          state: "ready",
          data: {
            state: "awaiting_source_confirmation",
            clusters: [
              {
                clusterId: "workspace:事故/照片",
                title: "事故/照片",
                sourceKind: "workspace",
                status: "candidate",
                summary: "2 sources",
                score: 0.9,
                sources: [],
              },
            ],
            answer: null,
            citations: [],
            warnings: [],
          },
        },
      })
      .mockResolvedValueOnce({
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

    render(<ChatLayout client={client} />);
    fireEvent.change(screen.getByPlaceholderText(/timeline/i), {
      target: { value: "整理事故时间线" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
    fireEvent.click(await screen.findByText("事故/照片"));
    fireEvent.click(screen.getByRole("button", { name: /Synthesize/i }));

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

    render(<ChatLayout client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: /Delete chat Research chat/i }));
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

    render(<ChatLayout client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: /Delete chat First chat/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() => {
      expect(client.deleteSession).toHaveBeenCalledWith({ sessionId: "s1" });
    });
    expect(await screen.findByRole("heading", { name: "Second chat" })).toBeInTheDocument();
  });
});
