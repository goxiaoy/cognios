---
date: 2026-05-17
topic: agentic-chat-tool-loop
---

# Agentic Chat Tool Loop

## Summary

Chat introduces an external agent SDK/framework as the runtime layer for model-directed tool use. V1 proves the agentic loop with two read-only workspace tools, letting the model decide whether to answer directly, search the workspace, read nodes, or continue reasoning from tool results.

---

## Problem Frame

Current Chat behavior is not truly agentic because retrieval happens before the model decides what the turn needs. Even a low-information greeting such as "hi" can be routed through search and clustering, which makes the product feel brittle and undermines user trust in the assistant's judgment.

The user wants the model to own the decision boundary around tool use. Search, reading, and future capabilities should be available to the model as tools, not forced pre-processing steps that run for every turn. This matters most for extensibility: the runtime shape should support more tools, richer permissions, traces, and longer multi-step behavior later without trapping Cognios in a one-off orchestrator.

---

## Actors

- A1. Workspace user: asks Chat questions and expects the assistant to use workspace tools only when useful.
- A2. Chat model: decides during a turn whether to answer directly or call available tools.
- A3. Agent runtime framework: manages the model-tool loop, tool calls, tool results, limits, and traces.
- A4. Cognios workspace tools: expose bounded read-only access to indexed workspace search and node content.

---

## Key Flows

- F1. Direct conversational turn
  - **Trigger:** The user sends a greeting, casual reply, or generic question that does not need workspace grounding.
  - **Actors:** A1, A2, A3
  - **Steps:** The runtime starts the turn with available tool definitions; the model chooses not to call a tool; Chat streams or returns a normal assistant response.
  - **Outcome:** No workspace search, web search, node read, or source cluster is triggered for the turn.
  - **Covered by:** R1, R2, R5, R11

- F2. Workspace-grounded research turn
  - **Trigger:** The user asks about their notes, files, prior material, or workspace state.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** The model calls workspace search, reviews returned source candidates, reads selected nodes, may repeat within limits, then answers with citations.
  - **Outcome:** The answer is grounded in model-selected workspace evidence rather than unconditional pre-turn retrieval.
  - **Covered by:** R1, R3, R4, R6, R7, R8

- F3. Unsupported provider path
  - **Trigger:** The selected chat provider or model cannot support the chosen agent runtime's native tool-calling requirements.
  - **Actors:** A1, A3
  - **Steps:** Chat detects the unsupported capability and presents an actionable state instead of silently falling back to non-agentic behavior.
  - **Outcome:** The user understands that the current model cannot run agentic Chat and can switch provider or model.
  - **Covered by:** R9, R10

---

## Requirements

**Agent Runtime Shape**
- R1. Chat must use an external agent SDK/framework as the execution layer for agentic turns, chosen for future extensibility rather than because V1 needs many tools.
- R2. The runtime must let the model decide whether to call tools. Search, read, and future tools must not run as unconditional pre-processing for every user message.
- R3. V1 must support a bounded tool loop where the model can call a tool, receive the result, decide whether another tool call is needed, and then produce the final answer.
- R4. The runtime must enforce turn limits, including a maximum number of tool-call rounds and clear failure behavior when limits or tool errors occur.
- R5. Tool activity must be visible enough for the user to understand when the assistant searched or read content, without exposing raw framework internals as the main transcript.

**V1 Tool Set**
- R6. V1 exposes a read-only `search_workspace` capability that returns ranked workspace candidates with stable node identifiers, source labels, snippets, paths where available, and enough metadata for the model to choose what to read next.
- R7. V1 exposes a read-only `read_node` capability that returns bounded node content for model-selected workspace nodes and tolerates stale or unavailable nodes as normal recoverable outcomes.
- R8. Answers that use `search_workspace` or `read_node` results must include citations or source references that let the user inspect the underlying Cognios node.
- R9. V1 must not expose write tools. Creating notes, updating session notes, modifying existing notes, deleting nodes, changing settings, or saving web content are deferred.

**Provider and Compatibility**
- R10. Agentic Chat V1 requires providers/models that satisfy the selected framework's native tool-calling requirements. Unsupported providers must surface as unsupported for agentic Chat rather than pretending to be equivalent.
- R11. Chat must preserve a direct-answer path for turns where the model does not call tools, including greetings and casual conversation.
- R12. The runtime must not require all existing Chat providers to support agentic mode before V1 can ship.

**Trust, Privacy, and Safety**
- R13. Retrieved workspace content remains untrusted data. Tool results must not override system behavior, grant new permissions, or authorize writes.
- R14. Cloud-provider use must follow the existing privacy posture: prompts, tool definitions, tool arguments, and selected workspace content may leave the device depending on provider configuration, and the UI must not obscure that fact.
- R15. Tool traces and persisted session records should preserve user-visible tool summaries, source references, and errors, but should not persist full raw provider payloads unless a user-visible need is defined later.

---

## Acceptance Examples

- AE1. **Covers R2, R11.** Given Chat is configured with an agentic-capable model, when the user sends "hi", Chat returns a normal conversational response and records no workspace search or node read for that turn.
- AE2. **Covers R3, R6, R7, R8.** Given the workspace contains relevant indexed content, when the user asks Chat to find and summarize related material, the model calls workspace search, reads one or more chosen nodes, and answers with source references.
- AE3. **Covers R4, R7.** Given a searched node is stale or unavailable, when the model attempts to read it, the runtime reports a recoverable tool result and the model can continue with other sources or explain the gap.
- AE4. **Covers R9, R13.** Given retrieved content asks the assistant to create or modify a note, when that instruction appears only inside tool results, the runtime does not expose or execute a write action in V1.
- AE5. **Covers R10, R12.** Given the selected provider does not support agentic tool calling, when the user opens or sends a message in agentic Chat, the UI shows that the provider is unsupported for agentic mode and does not silently run the old unconditional retrieval flow.

---

## Success Criteria

- A trivial greeting or casual prompt completes without search, read, web lookup, source clustering, or citation UI noise.
- A workspace question can cause the model to search, read, and answer with citations in the same turn.
- A downstream planner can evaluate external agent frameworks against clear requirements: extensibility, native tool calling, bounded execution, provider compatibility, traceability, and Cognios permission boundaries.
- The V1 scope proves model-directed read-only tool use without forcing the product into a general-purpose agent platform.

---

## Scope Boundaries

- No write tools in V1.
- No arbitrary plugin marketplace or user-defined tool registry in V1.
- No multi-agent behavior, swarm orchestration, unattended task queue, or long-running background agent jobs in V1.
- No provider-agnostic text/JSON tool-call simulation in V1.
- No requirement that every existing Chat provider remain available in agentic mode.
- No automatic pre-turn source clustering for every message. Clustering may be used only when it follows from model-directed tool use or a later explicit product decision.
- No automatic saving of web results or workspace mutations as a side effect of read-only research.

---

## Key Decisions

- External agent framework over a thin self-built loop: the primary reason is extensibility for future tools, permissions, traces, and more complex agent behavior.
- Native tool calling over provider-agnostic simulation: V1 favors clear agentic semantics even if it narrows provider compatibility.
- Read-only V1 tool set: `search_workspace` and `read_node` are enough to prove the core bet while keeping safety and permission boundaries tight.
- Model decides tool use: the runtime provides tools and limits, but it does not search or read before the model asks.
- Existing cluster-first behavior must adapt: source clusters can remain useful, but they cannot be the unconditional first step for every Chat turn.

---

## Dependencies / Assumptions

- The selected external framework can run inside the sidecar's runtime constraints and integrate with Cognios' provider configuration, streaming expectations, and local-first trust boundaries.
- At least one intended V1 provider/model path supports the framework's native tool-calling requirements well enough to ship agentic Chat.
- Existing workspace search and node-content surfaces can be wrapped as safe read-only tools with bounded payloads.
- Planning will evaluate framework options before implementation and should not treat this document as selecting a specific library.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R10][Needs research] Which external agent SDK/framework best fits Cognios' Python sidecar, native tool calling, streaming, tracing, and provider constraints?
- [Affects R4][Technical] What default maximum tool-call round count and timeout should V1 use?
- [Affects R6, R7][Technical] What payload size limits should `search_workspace` and `read_node` enforce to keep provider-bound context bounded?
- [Affects R5, R15][Technical] What exact tool trace data should be persisted versus shown transiently in the UI?
