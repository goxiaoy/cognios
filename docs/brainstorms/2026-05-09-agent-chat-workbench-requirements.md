---
date: 2026-05-09
topic: agent-chat-workbench
---

# Agent Chat Workbench

## Problem Frame

Cognios already has a substantial local search system and a placeholder `Chat`
section, but no product surface that lets an LLM use the indexed workspace on
the user's behalf. The original search requirements intentionally stopped at an
agent-callable `search` API and excluded answer synthesis. That leaves the next
capability clear: Chat should become an agent workbench that can search, read,
synthesize, and create new notes while preserving session history.

The target user wants the LLM to operate over their Cognios workspace, not just
answer generic prompts. V1 should feel like an agent workbench, but it is not a
general agent platform: the initial tool set is fixed to search, read, and
confirmed create-note flows.

## Requirements

**Agent Workbench Behavior**
- R1. The Chat section is a real conversational workspace, replacing the current
  placeholder. It supports multi-turn interaction, visible assistant/tool
  progress, and source-aware answers grounded in Cognios content when tools are
  used.
- R2. The assistant can automatically use read-only Cognios tools during a turn:
  workspace search, node content retrieval, and any needed metadata lookup that
  does not mutate user data.
- R3. The assistant can propose limited write actions: create a new note and
  save a chat/session summary as a note. Every write action requires explicit
  user confirmation before execution. "Save summary as note" is a preset of the
  same create-note flow, differing only in how the note content is prefilled.
- R4. V1 must not let the assistant directly modify or delete existing nodes.
  Editing existing notes, moving nodes, deleting nodes, or changing settings are
  out of scope until a stronger permission and conflict model exists.
- R5. Tool activity is understandable to the user. The UI shows when the
  assistant is searching, reading a result, or waiting for confirmation to create
  a note. Raw implementation traces are not shown as the main conversation, but
  users can tell why an answer has sources.

**Search and Knowledge Access**
- R6. Chat exposes the existing search capability to the LLM as a tool with the
  same result semantics used by the UI: stable `node_id`, kind, name, snippet,
  path, score, and stale-ID tolerance.
- R7. Chat can read selected search results before answering. Source citations
  in assistant responses refer back to Cognios nodes so the user can open the
  underlying note, file, URL, image extract, or PDF result.
- R8. The assistant should prefer searching Cognios when the user asks about
  their own knowledge, files, notes, prior material, or workspace state. It may
  answer without search for generic questions that do not require workspace
  grounding.
- R9. Search/read failures are recoverable within the turn. If a node is stale
  or content is unavailable, the assistant should continue with the remaining
  sources and explain the gap only when it materially affects the answer.
- R9a. Chat handles sidecar warm-up and outage states explicitly. When search or
  content reads are `initialising` or `unavailable`, the UI shows that workspace
  tools are temporarily unavailable and the assistant may either wait/retry or
  answer without workspace grounding, clearly labeling the answer as ungrounded.
- R9b. Citations render as compact source chips or inline source markers that
  open the referenced Explorer node. Missing or stale sources remain visible as
  unavailable sources when they materially affected the answer.

**Sessions and History**
- R10. Chat supports multiple sessions. A session has a title, creation/update
  timestamps, ordered messages, tool-call records, confirmation decisions, and
  links to any notes created from the session.
- R11. Session history persists across app restarts and is browsable from the
  Chat section. Opening an old session restores the visible transcript, tool-call
  records, citations, confirmation decisions, rejected proposals, and
  created-note links. It does not replay prior tools or resume interrupted
  executions.
- R12. Users can start a new session, rename or rely on generated session
  titles, delete sessions, and resume recent sessions without using the file
  system directly. Generated titles are the default; users may keep them or
  rename the session.
- R13. A session may use its recent history as conversational context, but the
  system should avoid sending unbounded history to the provider. Older context
  can be summarized or omitted according to a clear policy surfaced during
  planning.
- R13a. Session history is workspace-local Cognios data, not global app profile
  data. Rust-owned workspace storage is the canonical source for chat history;
  sidecar-owned storage may cache runtime state but must not become the source of
  truth. Session history participates in the same backup expectations as other
  workspace data.
- R13b. Session storage is memory-ready. V1 persists the full user-visible
  transcript plus a structured, incrementally updateable session summary so a
  future memory pipeline can extract long-term memory without reprocessing every
  raw message on every run.
- R13c. V1 does not generate long-term memory from chat automatically. It only
  preserves the source material and summary shape needed for a later memory
  feature.
- R13d. Session summaries use dirty + threshold coalescing. After each assistant
  turn, the session summary is marked dirty. A summary refresh runs when either
  5 assistant turns have completed since the last summary, 10 minutes of active
  session time have elapsed since the last summary, the user switches sessions,
  the app is about to exit, or the user manually requests a refresh.
- R13e. Summary refresh is best-effort and non-blocking. Consecutive dirty
  events coalesce into one pending refresh job; a provider failure leaves the
  summary marked stale and never blocks normal chat. Future memory extraction can
  consume only ready summaries or trigger a bounded refresh first.

**Providers and Models**
- R14. The provider system adds a `chat` capability. Chat provider selection
  reuses the existing provider/capability/settings mental model used by search
  features.
- R15. V1 supports Ollama as the primary local chat provider. It should work for
  users running a local Ollama server and expose model selection in Settings.
  Ollama is a host runtime, not a ModelManager download: V1 needs a default base
  URL, health check, model-list behavior, and clear missing-server state.
- R16. V1 supports cloud chat providers through configured provider presets,
  starting with one OpenAI-compatible chat adapter path rather than bespoke
  per-vendor implementations. OpenAI and Qwen DashScope can be presets on that
  path if their chat models work through the compatible API; custom
  OpenAI-compatible endpoints are acceptable only if they reuse the same UX and
  adapter.
- R17. Cloud chat provider use follows the existing privacy posture: API keys
  stay in the OS keychain, provider settings store references only, and the UI
  clearly discloses that prompts, selected context, and generated tool inputs may
  be sent to the configured provider.
- R18. Chat provider failures surface as actionable UI states. A missing Ollama
  server, missing cloud key, unreachable base URL, or unsupported model should
  not break the rest of the app.
- R18a. Provider-bound payloads are minimized. The chat runtime sends only the
  excerpts and session context needed for the current turn, not entire matched
  documents by default.

**Security and Privacy**
- R18b. Retrieved workspace content is treated as untrusted data, never as
  higher-priority instruction. Content from notes, files, URLs, PDFs, OCR, and
  captions must not be allowed to override system instructions, trigger tools by
  itself, or bypass write confirmation.
- R18c. Cloud-provider payloads should avoid obvious secrets and unrelated
  workspace content. Planning should define the concrete redaction/minimization
  rules and any extra confirmation gate for unusually sensitive context.
- R18d. Session records should persist user-visible messages, tool summaries,
  source references, confirmation decisions, and created-note links. Full raw
  provider payloads and full raw tool outputs should not be persisted unless the
  user-visible product need is explicit.
- R18e. Any new local chat/tool endpoint follows the existing sidecar trust
  boundary: loopback-only, authenticated where applicable, not exposed to ambient
  network clients, and not callable by arbitrary web content.

**Permission and Confirmation Model**
- R19. Read-only tools execute automatically during an assistant turn.
- R20. Write tools pause the turn and present a confirmation UI that includes the
  proposed action, destination, and content preview. The write runs only after
  user approval.
- R21. Rejected write proposals are preserved in session history as rejected
  proposals, not silently discarded, so future context reflects what the user
  declined.
- R22. The default permission mode is safe-by-default: no session-level auto
  write permission in v1. A future session-level "allow automatic note creation"
  mode is explicitly deferred.
- R22a. Approved note creation is atomic from the user's perspective: either the
  new note exists with its approved title/body and the session records the link,
  or the session records a failed write without leaving an empty or misleading
  note artifact.

**User Experience**
- R23. The first Chat screen should be the usable chat experience, not a landing
  page. It includes the conversation area, composer, provider/model state, and a
  compact session list or affordance to open history.
- R24. The composer supports normal text prompts and should make it easy to ask
  workspace-grounded questions. It does not need slash commands in v1 unless
  planning finds an existing command pattern worth reusing.
- R25. Created notes should be discoverable immediately through the Explorer and
  later through search after indexing catches up. The UI should avoid implying
  that note creation instantly guarantees semantic-search availability.
- R26. Chat is keyboard-usable. The composer, session history, source links,
  tool-progress items, and write-confirmation prompts have clear focus order,
  labels, and live announcements for long-running tool activity.
- R27. On narrow screens, session history collapses behind a drawer or sheet so
  the active conversation and composer remain the primary surface.

## Success Criteria

- A user can ask Chat to find and synthesize information from their Cognios
  workspace; the assistant searches, reads relevant nodes, answers, and cites the
  source nodes.
- A user can ask Chat to turn a conversation or answer into a new note; the UI
  shows a preview and creates the note only after confirmation.
- A user can quit and reopen the app, then resume a previous chat session with
  its messages, tool activity, source references, and created-note links intact.
- A user can use a local Ollama model for chat without configuring a cloud key.
- A user can configure a cloud chat provider using the existing provider model
  and understands what workspace content may leave the device.
- A failed provider or stale search result degrades the current turn without
  crashing Chat or the rest of Cognios.

## Scope Boundaries

- No direct modification or deletion of existing nodes in v1.
- No autonomous background tasks outside an active user session.
- No multi-agent swarm behavior, task queue, or long-running unattended plan
  execution in v1.
- No plugin system, generalized agent framework, or arbitrary tool registry in
  v1. The initial tool set may be hardcoded to search, read, create-note, and
  summary-as-note.
- No replaying prior tool executions or resuming interrupted provider calls when
  an old session is opened.
- No provider cost tracking, token budget dashboard, or quota management in v1.
- No cross-device chat sync in v1; session history is local to the workspace.
- No automatic long-term memory generation from chat in v1.
- No guarantee that every provider supports native function-calling. Planning may
  choose a provider-agnostic tool loop that works across local and cloud models.
- No web search unless a separate web-search capability is explicitly added
  later. "Search" in v1 means Cognios workspace search.

## Key Decisions

- Agent workbench over simple RAG chat: The user chose the higher-capability
  framing. V1 still starts with a fixed search/read/create-note tool set; broader
  tool extensibility is a post-v1 product bet, not a v1 implementation mandate.
- Limited write scope: V1 allows creating new notes and saving summaries, but not
  modifying existing content. This gives the assistant durable output without
  introducing edit conflict handling or broad destructive permissions.
- Automatic read tools, confirmed writes: Read-only search and content access
  should not interrupt the conversation. Mutations require confirmation because
  they alter the user's workspace.
- Reuse provider/capability settings: Existing provider presets explicitly defer
  `chat`; this feature should add that capability rather than inventing a
  separate chat-only settings system.
- Ollama first for local chat: Local chat is a core requirement, and Ollama is
  the expected v1 local runtime.
- Workspace-local session storage: Chat history should belong to the Cognios
  workspace. Rust-owned workspace storage is the canonical source; sidecar-owned
  storage can cache runtime state but must not own chat history.
- Memory-ready history: Chat history is future input to Cognios memory. V1 keeps
  full transcript plus a maintained session summary, but defers actual memory
  extraction.
- Coalesced summary refresh: Session summaries refresh after meaningful activity
  thresholds, not after every turn. Defaults are 5 assistant turns or 10 minutes
  of active session time, with session switch, app exit, and manual refresh as
  additional triggers.

## Existing Context

- The search requirements already state that the search API should be
  agent-callable and return stable node IDs for later content reads:
  `docs/brainstorms/2026-04-26-search-requirements.md`.
- The current provider preset tables explicitly omit `chat` until this feature:
  `sidecar/search_sidecar/providers/presets.py` and
  `src/features/settings/data/providerPresets.ts`.
- The app sidebar has a Chat navigation item, but `src/app/App.tsx` currently
  renders non-Explorer/non-Settings sections as placeholders.
- The sidecar exposes `/search`, settings, model status, indexing status, and
  indexed node content surfaces that planning can reuse.

## High-Level Flow

```text
User prompt
  -> Chat session records user message
  -> Selected chat provider receives bounded session context + tool definitions
  -> Assistant may call search/read tools automatically
  -> Assistant answers with source references
  -> If assistant proposes create-note/save-summary
       -> UI shows confirmation preview
       -> On approval, Cognios creates a new note and records the link
```

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R10-R13][Technical] Design Rust-owned workspace session storage for
  messages, tool summaries, confirmations, created-note links, and the maintained
  session summary. Sidecar-owned storage is not the canonical source for chat
  history.
- [Affects R14-R18][Needs research] Confirm the exact Ollama/OpenAI-compatible
  request surfaces to support, including streaming, tool-call compatibility, and
  model listing behavior.
- [Affects R20][Technical] Define the write-confirmation payload shape so note
  previews are deterministic and replayable from session history.
- [Affects R13][Technical] Define history compaction rules and maximum context
  budgets per provider/model.
- [Affects R13d-R13e][Technical] Decide which model/provider performs session
  summary refresh and how stale-summary retries are scheduled without blocking
  chat.
- [Affects R18b-R18d][Security] Define the concrete prompt-injection,
  minimization, redaction, and persisted-audit rules used by the chat runtime.

## Next Steps

-> /ce:plan for structured implementation planning
