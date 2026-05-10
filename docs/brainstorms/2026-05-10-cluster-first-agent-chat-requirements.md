---
date: 2026-05-10
topic: cluster-first-agent-chat
---

# Cluster-First Agent Chat

## Summary

Chat becomes a cluster-first research workbench that can search across the local
workspace and the web, surface candidate source clusters, answer user-driven
questions, and maintain one live Note per research session as the durable
working draft.

---

## Problem Frame

Cognios already has a navigable local workspace, mounted folders, notes, and
search foundations, but users still have to manually connect scattered evidence
when they want to answer a real research question. Sometimes the relevant
material is deliberately organized under one folder, such as photos, PDFs, and
documents for one incident. Other times the user has not organized it, so the
right material is spread across notes, mounted files, URLs, PDFs, OCR output,
and images.

The old "chat assistant" framing is too generic for this moment. A useful Chat
surface must not simply answer one prompt and disappear; it must help the user
find likely source clusters, steer which evidence counts, keep asking and
answering follow-up questions, and leave behind a readable working Note that
captures the current state of the research.

---

## Actors

- A1. Workspace user: asks research questions, confirms or corrects source
  clusters, and uses the resulting Note as the durable output.
- A2. Chat assistant: uses configured chat providers plus workspace and web
  search sources to retrieve, read, synthesize, cite, and update the session
  Note.
- A3. Source systems: local workspace content and web results that can be
  searched, clustered, read, cited, and distinguished by provenance.

---

## Key Flows

- F1. Cluster-first research start
  - **Trigger:** The user asks a broad research question, such as "find the
    material about this incident and summarize it."
  - **Actors:** A1, A2, A3
  - **Steps:** Chat searches the workspace and web, groups promising results
    into candidate source clusters, labels each cluster by provenance and
    theme, and asks the user to confirm, exclude, or redirect the cluster set.
  - **Outcome:** The session has a user-accepted working source set before the
    assistant produces a substantive synthesis.
  - **Covered by:** R1, R2, R3, R4, R8, R9

- F2. User-driven synthesis and follow-up
  - **Trigger:** The user asks a focused question after source clusters are
    accepted, such as "what happened on March 1?" or "what are the costs?"
  - **Actors:** A1, A2, A3
  - **Steps:** Chat reads relevant source material, shows an interruptible
    progress trail, answers with citations, accepts natural-language
    corrections, and adjusts the active source set or answer direction.
  - **Outcome:** The user gets a grounded answer and can keep steering the
    investigation without starting over.
  - **Covered by:** R5, R6, R7, R10, R11, R12

- F3. Live session Note creation and maintenance
  - **Trigger:** Chat produces the first substantive synthesis in a session.
  - **Actors:** A1, A2
  - **Steps:** Chat creates or binds one Note for the session, writes the current
    synthesis into it, and on later turns intelligently merges new conclusions
    into the same Note rather than appending raw chat logs.
  - **Outcome:** The research session has one live, editable, deletable Note
    that represents the current working draft.
  - **Covered by:** R13, R14, R15, R16, R17

- F4. Session recovery
  - **Trigger:** The user returns to a previous Chat session.
  - **Actors:** A1, A2
  - **Steps:** Chat restores the transcript, source cluster choices, citations,
    tool/progress summaries, provider context, and the bound session Note.
  - **Outcome:** The user can continue the research from the prior state without
    treating the Note as the only record of the session.
  - **Covered by:** R18, R19, R20

---

## Requirements

**Provider Chat Runtime**
- R1. Chat must support basic multi-turn conversation through a configured chat
  provider.
- R2. Chat provider selection must fit the existing provider/capability mental
  model by adding or enabling a `chat` capability rather than creating an
  unrelated settings model.
- R3. Provider failure states, missing configuration, unavailable local
  runtimes, and unsupported models must surface as actionable Chat states
  without breaking non-Chat areas of Cognios.

**Workspace and Web Retrieval**
- R4. Chat must search across the local Cognios workspace by default, including
  notes, mounted files, URL content, PDFs, OCR/captioned images, and any other
  content already indexed for search.
- R5. Web search is a first-class v1 source. Chat may search the web alongside
  workspace sources during normal research, not only as a fallback.
- R6. Local path and folder structure must be a relevance signal. Results that
  share a mount, folder, subtree, path pattern, or neighboring context should be
  eligible to form a stronger local source cluster than isolated text matches.
- R7. Web results must retain separate provenance from workspace results. The UI
  and generated answers must make it clear whether a claim came from local
  workspace content or web content.

**Source Clusters**
- R8. For broad research prompts, Chat must present candidate source clusters
  before producing the main synthesis. Local clusters should be understandable
  through path or folder grouping; web clusters should be understandable through
  search topic, source set, or shared theme.
- R9. The user can confirm, exclude, or redirect source clusters before the main
  synthesis. The accepted source set becomes part of the session state.
- R10. Chat can proceed when the user accepts more than one cluster, including a
  mix of workspace and web clusters.
- R11. Chat must tolerate imperfect clustering. If relevant material appears
  outside the accepted cluster set during later turns, Chat can surface it as a
  candidate addition instead of silently ignoring it.

**User-Driven Synthesis**
- R12. Output is driven by the user's question, not by a fixed template. If the
  user asks for a timeline, Chat produces a timeline; if the user asks for
  costs, Chat extracts and organizes costs; if the user asks for a general
  summary, Chat summarizes.
- R13. Chat must show an interruptible research process, including the broad
  stage it is in: searching, clustering, reading, synthesizing, updating the
  session Note, or waiting for user correction.
- R14. The user can intervene lightly during the process by changing selected
  clusters, excluding source categories, or correcting direction in natural
  language. V1 does not require a detailed per-file or per-webpage reading
  control console.
- R15. Answers and Note content must include source references that distinguish
  local workspace sources from web sources.

**Live Session Note**
- R16. Each Chat session has at most one bound live Note. The Note is created
  only after the first substantive synthesis, not when the user opens Chat or
  sends an initial prompt.
- R17. The live Note is the session's working draft, not the chat transcript.
  Chat updates it by intelligently merging relevant new conclusions into the
  existing content and by keeping the Note readable as a current artifact.
- R18. Chat may automatically update only the Note bound to the current Chat
  session. It must not automatically modify unrelated user-created Notes.
- R19. The live Note does not need per-turn version history in v1. The user can
  delete the Note if they do not want to keep the research artifact.
- R20. Note structure should emerge from the user's questions and the material
  found. V1 must not force every session into a fixed incident-report,
  timeline, or cost-table template.

**Session History**
- R21. Chat session history must persist independently from the live Note.
  Restoring a session should restore user messages, assistant messages, source
  cluster selections and exclusions, citations, progress/tool summaries, provider
  context needed to understand the conversation, and the bound Note link.
- R22. The live Note is not a replacement for session history. A user should be
  able to reopen a session and understand how the Note was produced, even if the
  Note has been edited after generation.
- R23. Opening an old session must not replay prior searches, web requests, or
  provider calls automatically. It restores the record and can continue from
  there when the user sends a new prompt.

**Safety, Trust, and Privacy**
- R24. Workspace content and web content must be treated as untrusted source
  material. Retrieved text must not override system behavior, grant itself tool
  permission, or bypass the user's cluster and direction controls.
- R25. Cloud-provider and web-search use must clearly disclose that prompts,
  queries, selected context, and generated tool inputs may leave the device
  depending on provider configuration.
- R26. Chat must avoid implying that web sources have been added to the user's
  local knowledge base unless the user explicitly saves them.

---

## Acceptance Examples

- AE1. **Covers R4, R6, R8, R9.** Given workspace content about an incident is
  concentrated under one mounted folder, when the user asks Chat to summarize
  the incident without naming the folder, Chat presents that folder/subtree as a
  candidate local source cluster before the main synthesis.
- AE2. **Covers R4, R5, R7, R10, R15.** Given relevant evidence exists both in
  local PDFs and on web pages, when the user accepts one local cluster and one
  web cluster, Chat synthesizes from both and labels citations by source type.
- AE3. **Covers R12, R17, R20.** Given an accepted source set, when the user asks
  first for a timeline and later asks about costs, Chat answers each question
  according to that question and updates the live Note into a readable combined
  working draft rather than appending two raw chat excerpts.
- AE4. **Covers R16, R18, R19.** Given a new Chat session has not produced a
  substantive synthesis yet, no Note exists. When the first synthesis is
  produced, Chat creates one bound live Note. Later automatic updates affect only
  that Note.
- AE5. **Covers R21, R22, R23.** Given the user reopens a previous session, Chat
  shows the transcript, prior cluster choices, citations, progress summaries,
  and bound Note link without rerunning the old searches.
- AE6. **Covers R24, R25, R26.** Given web search is enabled, when Chat uses web
  results, the answer and Note identify them as web sources and do not treat them
  as saved local workspace content.

---

## Success Criteria

- A user can ask a broad research question without preselecting a folder, review
  candidate workspace and web source clusters, accept or redirect them, and get a
  grounded answer.
- A user can ask follow-up questions such as "what happened on March 1?" or
  "what are the costs?" and Chat answers from the active research context with
  clear citations.
- A Chat session creates one live Note after the first substantive synthesis and
  keeps that Note updated as a readable working draft through follow-up turns.
- Reopening a session restores both the chat history and the bound live Note
  relationship, so the user can continue the investigation later.
- A downstream planner does not need to invent the product behavior around source
  clusters, web-vs-workspace provenance, session Note semantics, or chat history
  persistence.

---

## Scope Boundaries

- No fixed accident report, timeline, or cost-table template as the default
  product shape.
- No complex per-file or per-webpage reading control console in v1.
- No automatic modification of user-created Notes outside the current session's
  bound live Note.
- No per-turn Note version history or built-in rollback in v1.
- No multi-agent swarm behavior, plugin system, arbitrary tool registry, or
  long-running unattended task queue.
- No automatic saving of web pages as URL nodes or long-term indexed content
  unless the user explicitly requests that save action.
- No guarantee that every provider supports native tool/function calling; v1 may
  choose a provider-compatible interaction model during planning.

---

## Key Decisions

- Cluster-first over answer-first: Broad prompts should surface candidate source
  clusters before the main synthesis so the user can correct scope early.
- Workspace and web as first-class sources: Web search is not a fallback-only
  feature, but web provenance must remain distinct from local workspace
  provenance.
- Path-aware local relevance: Folder and mount structure is valuable evidence of
  relatedness, but the system must still work when the user has not organized the
  material.
- User-driven output: The product should follow the user's question instead of
  imposing an incident-report template.
- One live Note per session: The durable artifact is a readable working draft,
  while chat history remains the process record.
- Automatic writes are bounded: Chat may update the session's bound Note, but
  not unrelated user Notes.
- Session history remains first-class: The Note is not sufficient to recover the
  research process or explain how conclusions were produced.

---

## Existing Context

- `docs/brainstorms/2026-05-09-agent-chat-workbench-requirements.md` captured
  the earlier generic workbench framing and should be treated as superseded
  product context, not as the authoritative v1 scope.
- `docs/brainstorms/2026-04-26-search-requirements.md` established workspace
  search as agent-callable and deliberately excluded answer synthesis at that
  time.
- `docs/brainstorms/vfs-node-management-requirements.md` established Mount and
  Folder semantics, including mounted folder structure as a meaningful user
  organization layer.
- `docs/brainstorms/notes-node-type-requirements.md` established Note behavior
  as a local markdown-backed node that users can edit and delete.
- `docs/brainstorms/2026-05-02-feature-oriented-settings-requirements.md`
  established the provider/capability mental model and deferred `chat` until the
  chat feature is in scope.

---

## Dependencies / Assumptions

- Workspace search and content reading are available or planned enough for Chat
  to call them as read-only research tools.
- Note creation and saving can support a Chat-owned live Note without changing
  the user's mental model for normal Notes.
- Web search access is available through a provider or integration selected
  during planning.
- The user accepts that web queries and cloud chat providers may involve
  off-device requests when those capabilities are configured.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R1-R3][Needs research] Confirm which chat providers and local
  runtimes support the required interaction loop, including streaming and tool
  use or a provider-compatible alternative.
- [Affects R4-R11][Technical] Define the retrieval and clustering strategy that
  combines text relevance, local path proximity, and web-source grouping without
  hiding relevant scattered material.
- [Affects R5, R7, R25-R26][Needs research] Choose the web search provider or
  integration and define disclosure, rate-limit, privacy, and source-preview
  behavior.
- [Affects R16-R23][Technical] Design session persistence for transcript,
  cluster decisions, citations, progress summaries, provider context, and bound
  Note identity.
- [Affects R17-R20][Technical] Define the Note merge behavior so automatic
  updates preserve readability without requiring per-turn version history.
- [Affects R24-R26][Security] Define prompt-injection handling, content
  minimization, source trust labeling, and provider-bound payload rules for
  mixed workspace and web context.
