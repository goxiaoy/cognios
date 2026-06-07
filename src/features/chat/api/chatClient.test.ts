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

  it("loads a Session Memory body through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      available: true,
      body: "## Timeline",
      revision: 2,
    });

    await chatClient.getSessionMemory({ sessionId: "s1" });

    expect(mockedInvoke).toHaveBeenCalledWith("get_chat_session_memory", {
      input: { sessionId: "s1" },
    });
  });

  it("exports Session Memory through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      noteId: "n1",
      snapshot: { roots: [] },
    });

    await chatClient.exportSessionMemory({ sessionId: "s1" });

    expect(mockedInvoke).toHaveBeenCalledWith("export_chat_session_memory", {
      input: { sessionId: "s1" },
    });
  });

  it("triggers a Session Memory refresh opportunity through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await chatClient.triggerMemoryOpportunity({
      sessionId: "s1",
      reason: "session_switch",
    });

    expect(mockedInvoke).toHaveBeenCalledWith("trigger_chat_session_memory_opportunity", {
      input: {
        sessionId: "s1",
        reason: "session_switch",
      },
    });
  });

  it("updates a chat session title through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      id: "s1",
      title: "事故时间线",
      boundNoteId: null,
      createdAt: "now",
      updatedAt: "now",
    });

    await chatClient.updateSessionTitle({
      sessionId: "s1",
      title: "事故时间线",
    });

    expect(mockedInvoke).toHaveBeenCalledWith("update_chat_session_title", {
      input: {
        sessionId: "s1",
        title: "事故时间线",
      },
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
          state: "ready",
          clusters: [],
          answer: "answer",
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

  it("loads chat models through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      models: {
        state: "ready",
        data: {
          state: "ready",
          providerId: "local-ollama",
          models: [{ id: "llama3.2", name: "llama3.2" }],
          cached: false,
          warnings: [],
        },
      },
    });

    await chatClient.getModels();

    expect(mockedInvoke).toHaveBeenCalledWith("get_chat_models");
  });

  it("loads realtime voice status through the Tauri command", async () => {
    mockedInvoke.mockResolvedValueOnce({
      status: {
        state: "ready",
        data: {
          status: "unavailable",
          available: false,
          local: true,
          provider: "qwen3-asr-vllm",
          reason: "Local realtime ASR runtime is not packaged with this build.",
          packaging: "missing",
        },
      },
    });

    await chatClient.getRealtimeVoiceStatus();

    expect(mockedInvoke).toHaveBeenCalledWith("get_realtime_voice_status");
  });
});
