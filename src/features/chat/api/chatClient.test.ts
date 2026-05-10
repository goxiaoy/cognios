import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { chatClient } from "./chatClient";

const mockedInvoke = vi.mocked(invoke);

afterEach(() => {
  mockedInvoke.mockReset();
});

describe("chatClient", () => {
  it("creates a chat session through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      id: "s1",
      title: "Research",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    });

    const result = await chatClient.createSession({ title: "Research" });

    expect(mockedInvoke).toHaveBeenCalledWith("create_chat_session", {
      input: { title: "Research" },
    });
    expect(result.id).toBe("s1");
  });

  it("opens session history without a side effect command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      session: {
        id: "s1",
        title: "Research",
        boundNoteId: null,
        createdAt: "now",
        updatedAt: "now",
      },
      messages: [],
      clusters: [],
    });

    await chatClient.getSession({ sessionId: "s1" });

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("get_chat_session", {
      input: { sessionId: "s1" },
    });
  });

  it("appends a chat message with metadata", async () => {
    mockedInvoke.mockResolvedValueOnce({
      id: "m1",
      sessionId: "s1",
      role: "user",
      body: "hello",
      ordinal: 0,
      metadataJson: "{}",
      createdAt: "now",
    });

    await chatClient.appendMessage({
      sessionId: "s1",
      role: "user",
      body: "hello",
      metadataJson: "{}",
    });

    expect(mockedInvoke).toHaveBeenCalledWith("append_chat_message", {
      input: {
        sessionId: "s1",
        role: "user",
        body: "hello",
        metadataJson: "{}",
      },
    });
  });

  it("starts a chat turn through the persisted Rust bridge", async () => {
    mockedInvoke.mockResolvedValueOnce({
      turn: {
        state: "ready",
        data: {
          state: "awaiting_source_confirmation",
          clusters: [],
          answer: null,
          citations: [],
          warnings: [],
        },
      },
    });

    await chatClient.startTurn({
      sessionId: "s1",
      query: "整理事故时间线",
      includeWeb: true,
    });

    expect(mockedInvoke).toHaveBeenCalledWith("start_chat_turn", {
      input: {
        sessionId: "s1",
        query: "整理事故时间线",
        includeWeb: true,
      },
    });
  });
});
