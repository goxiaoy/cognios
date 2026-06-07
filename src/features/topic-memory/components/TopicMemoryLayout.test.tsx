import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TopicMemoryDetail } from "../../../lib/contracts/topicMemory";
import type { TopicMemoryClient } from "../api/topicMemoryClient";
import { TopicMemoryLayout } from "./TopicMemoryLayout";

afterEach(() => cleanup());

function makeDetail(): TopicMemoryDetail {
  return {
    topic: {
      id: "topic-1",
      title: "Atlas",
      summary: "Launch memory across voice notes and workspace material.",
      status: "active",
      confidence: 0.9,
      rationale: "Repeated across sources.",
      createdAt: "now",
      updatedAt: "now",
    },
    sources: [
      {
        id: "source-1",
        topicId: "topic-1",
        nodeId: "meeting-1",
        nodeTitle: "Meeting Alpha",
        nodeKind: "voice-note",
        path: "Voice Notes/Meeting Alpha.md",
        chunkId: "meeting-1:0",
        chunkRole: "voice_transcript",
        anchorLabel: "Meeting Alpha",
        citation: {
          nodeId: "meeting-1",
          chunkId: "meeting-1:0",
          chunkRole: "voice_transcript",
          anchorLabel: "Meeting Alpha",
          path: "Voice Notes/Meeting Alpha.md",
        },
        status: "active",
        confidence: 0.9,
        rationale: "Repeated topic source.",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    items: [
      {
        id: "claim-1",
        topicId: "topic-1",
        itemType: "claim",
        title: "Atlas launch plan was reviewed",
        body: "Project Atlas launch plan was reviewed in the meeting.",
        occurredAt: null,
        citation: {
          nodeId: "meeting-1",
          chunkId: "meeting-1:0",
          chunkRole: "voice_transcript",
          anchorLabel: "Meeting Alpha",
        },
        status: "active",
        confidence: 0.8,
        rationale: "Accepted claim.",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    relationships: [],
    proposals: [
      {
        id: "proposal-1",
        topicId: "topic-1",
        proposalType: "claim",
        title: "Budget owner is Mei",
        bodyJson: "{}",
        status: "pending",
        confidence: 0.7,
        rationale: "High-impact attribution needs review.",
        signature: "claim:topic-1:budget",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };
}

function makeClient(detail = makeDetail()): TopicMemoryClient {
  return {
    list: vi.fn().mockResolvedValue([detail.topic]),
    get: vi.fn().mockResolvedValue(detail),
    refresh: vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        topicsCreated: 0,
        topicsUpdated: 1,
        sourcesApplied: 1,
        proposalsCreated: 1,
      },
    }),
    acceptProposal: vi.fn().mockResolvedValue({
      ...detail,
      proposals: [],
    }),
    dismissProposal: vi.fn().mockResolvedValue(true),
    archive: vi.fn().mockResolvedValue(true),
  };
}

describe("TopicMemoryLayout", () => {
  it("renders topic projections, citations, refresh, and review actions", async () => {
    const client = makeClient();
    const onActivateSource = vi.fn();

    render(<TopicMemoryLayout client={client} onActivateSource={onActivateSource} />);

    expect(await screen.findByRole("heading", { name: "Atlas" })).toBeInTheDocument();
    const citations = await screen.findAllByRole("button", {
      name: "Meeting Alpha · voice_transcript",
    });
    fireEvent.click(citations[0]);
    expect(onActivateSource).toHaveBeenCalledWith("meeting-1");

    fireEvent.click(screen.getByRole("button", { name: "Refresh Topic Memory" }));
    expect(await screen.findByText("0 new, 1 updated, 1 sources, 1 review items")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /review/i }));
    expect(screen.getByText("Budget owner is Mei")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept Budget owner is Mei" }));

    await waitFor(() => {
      expect(client.acceptProposal).toHaveBeenCalledWith({ proposalId: "proposal-1" });
    });
  });
});
