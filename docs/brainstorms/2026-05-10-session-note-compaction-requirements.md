---
date: 2026-05-10
topic: session-note-compaction
---

# Session Note Compaction

## Summary

Chat sessions will maintain one read-only session note that is both the user's
visible session summary and the compact long-context input for future turns.
The note is generated and refreshed asynchronously by the active chat model,
using threshold-based coalescing instead of overwriting it on every reply.

---

## Problem Frame

The current live note behavior is too close to "last answer mirrored into a
Note." It does not preserve what the session has learned over time, and it makes
the note feel like a mutable user artifact even though automatic rewrites can
replace its content.

Long chat sessions also need a compact context primitive. Sending the full
transcript forever is wasteful and eventually unsafe for context windows, while
maintaining a separate hidden model summary would create two competing sources
of truth. The session needs one compact artifact that is readable by the user
and useful to the model.

---

## Actors

- A1. Session user: asks questions, reads the session note inside Chat, and may
  save a snapshot into a normal editable Note.
- A2. Chat runtime: answers turns, tracks successful replies, and decides when
  the session note is dirty enough to refresh.
- A3. Session note maintainer: uses the current chat model to rewrite the
  session note as a compact working document.

---

## Key Flows

- F1. Initial session note generation
  - **Trigger:** The first successful assistant reply completes in a session.
  - **Actors:** A1, A2, A3
  - **Steps:** Chat returns the assistant reply without waiting for note
    generation. In the background, the session note maintainer uses the session
    so far to produce an initial read-only working document. The note becomes
    visible from the session once ready.
  - **Outcome:** The session has one compact note without blocking the user's
    chat flow.
  - **Covered by:** R1, R2, R4, R4a, R6, R7, R7a

- F2. Coalesced note refresh
  - **Trigger:** Successful assistant replies accumulate after the last note
    refresh.
  - **Actors:** A2, A3
  - **Steps:** Chat marks the session note dirty after successful replies.
    Refresh runs only when the dirty work crosses a turn threshold, a token
    threshold, a session switch, or an idle opportunity. If a refresh is already
    running, later dirty events coalesce instead of starting another update.
  - **Outcome:** The session note stays reasonably current without a model call
    after every reply.
  - **Covered by:** R3, R5, R8, R9, R10, R11

- F3. Future chat turn context
  - **Trigger:** The user sends a follow-up in a session that has a successful
    session note.
  - **Actors:** A1, A2
  - **Steps:** Chat builds the next prompt from the latest successful session
    note plus the most recent raw conversation turns. If the note is stale or a
    refresh failed, Chat continues with the last successful note and recent raw
    turns.
  - **Outcome:** Long sessions retain continuity while recent details remain
    available verbatim.
  - **Covered by:** R16, R17, R17a, R17b, R18a

- F4. Save session note as normal Note
  - **Trigger:** The user chooses to keep the current session note as editable
    workspace material.
  - **Actors:** A1, A2
  - **Steps:** Chat creates a normal editable Note from the current session note
    content as a one-time snapshot. The session note remains read-only and
    continues to evolve separately.
  - **Outcome:** The user can promote useful session output into the workspace
    without making the session note itself editable.
  - **Covered by:** R19, R20, R20a

- F5. Session deletion
  - **Trigger:** The user deletes a chat session.
  - **Actors:** A1, A2
  - **Steps:** Chat deletes the session and its derived session note together.
    If the user wants to keep the content, they must save a normal Note snapshot
    before deletion.
  - **Outcome:** Session notes do not become hidden orphan artifacts.
  - **Covered by:** R21

---

## Requirements

**Session Note Identity**
- R1. Each chat session may have at most one session note.
- R2. The session note is a read-only derived session artifact, not a normal
  editable Note and not a replacement for the full chat transcript.
- R3. The session note is the single compact session artifact. V1 must not
  maintain a second hidden summary with different content for prompt context.
- R4. The session note is visible from the Chat session, but it does not appear
  in Explorer by default.
- R4a. Chat exposes the session note through a dedicated surface associated
  with the active session. The chat transcript remains available as the durable
  record, and the session-note surface groups the read-only note content with
  the Save as Note action when a note exists.
- R4b. Unsaved session notes are accessible only through their owning Chat
  session and must be excluded from Explorer, workspace search/indexing, and
  unrelated chat retrieval. When the user saves a snapshot as a normal Note,
  that snapshot follows normal Note visibility, indexing, and deletion behavior.
- R5. The session note should not expose update-state chrome in V1. Users see
  the note content itself, not updating, stale, failed, queue, or retry status.
  V1 copy must not imply that the visible note includes unsummarized recent
  turns.

**Generation and Refresh**
- R6. The first successful assistant reply in a session triggers asynchronous
  initial session note generation.
- R7. Session note generation and refresh must not block the chat reply or stop
  the user from sending another prompt.
- R7a. Before an initial session note exists, Chat must not show stale note
  content or an enabled Save as Note action. V1 may hide the session-note
  surface until content exists, or show a neutral unavailable state that does
  not expose queue, stale, failed, or retry status.
- R8. Only successful assistant replies mark the session note dirty. Provider
  errors, cancellations, empty responses, pure UI operations, and session
  deletion do not mark the note dirty. A pure UI operation may only create a
  refresh opportunity when prior successful replies have already made the note
  dirty.
- R9. After the initial note exists, refresh uses dirty plus threshold
  coalescing rather than refreshing after every reply.
- R10. V1 uses conservative fixed thresholds: refresh after about three
  completed conversation rounds, about 3,000 new estimated tokens, a session
  switch, or an idle opportunity.
- R11. If dirty events arrive while a refresh is already running, they coalesce
  into one later refresh opportunity instead of creating parallel updates.

**Content and Style**
- R12. Each refresh asks the current chat model to produce a complete new
  session note from the previous note plus new successful conversation content.
  It should not append a transcript, emit patches, or preserve an obsolete
  structure just because it appeared earlier.
- R12a. The previous session note is an input, not the authoritative source of
  truth. The durable transcript remains the recovery source for rebuilding or
  validating a session note when a refresh appears lossy, stale, or corrupted.
- R13. The session note uses a working-document style: concise, structured,
  scannable, and focused on conclusions, facts, timelines, costs, open
  questions, and useful source references.
- R14. The note structure can evolve by session. V1 must not force every session
  into one fixed template.
- R15. The note keeps lightweight source context. It should retain enough source
  references for trust and future context, without requiring sentence-by-sentence
  citation.
- R15a. Because the session note is future prompt context, each refresh must
  preserve the active question, durable user instructions, accepted and excluded
  source scope, user corrections, decisions, unresolved tasks, and source anchors
  needed for later turns, even when the note structure changes.

**Prompt Context**
- R16. Future chat prompts use the latest successful session note plus the most
  recent raw conversation turns.
- R17. If note refresh fails or lags behind, future prompts continue with the
  previous successful note plus recent raw turns.
- R17a. When the session note and recent raw turns conflict, prompt assembly
  must instruct the model to treat recent raw turns as newer and authoritative.
- R17b. User-authored facts, corrections, constraints, and decisions that arrive
  after the last successful note refresh remain available through recent raw
  turns until a later successful refresh captures them.
- R18. The model used for session note generation and refresh is the same model
  selected for the active chat session.
- R18a. Session note content and recent raw turns are prompt context data, not
  higher-priority instructions. User, workspace, web, or assistant-quoted content
  preserved in a session note must remain delimited/untrusted and must not
  override system/developer/provider instructions, trigger tools, or bypass write
  confirmation.

**User Control and Lifecycle**
- R19. Users can save the current session note as a normal editable Note.
- R20. Saving as a normal Note creates a one-time snapshot. The saved Note and
  the continuing session note do not sync afterward.
- R20a. After Save as Note succeeds, Chat provides a clear path to the newly
  created editable Note and makes clear that it is a snapshot. The saved Note
  appears wherever normal Notes are discoverable.
- R21. Deleting a chat session deletes its derived session note. Users who want
  to keep the content should save a normal Note snapshot first.
- R22. The session-note surface and Save as Note action must be reachable by
  keyboard, have accessible names, and communicate the note's read-only derived
  status to assistive technologies.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4, R4a, R6, R7, R7a.** Given a new chat session has no
  session note, when the first assistant reply succeeds, Chat returns the reply
  first and later shows a read-only session note inside that session.
- AE2. **Covers R8, R9, R10, R11.** Given a session note exists, when one
  follow-up reply succeeds, the note is marked dirty but does not necessarily
  refresh immediately. When about three rounds or about 3,000 new estimated
  tokens accumulate, one coalesced refresh runs.
- AE3. **Covers R12, R12a, R13, R14, R15, R15a.** Given a session first
  discusses an incident timeline and later discusses costs, when the session note
  refreshes, it becomes a coherent working document with both concerns
  represented rather than two pasted chat answers.
- AE4. **Covers R16, R17, R17a, R17b, R18a.** Given a note refresh failed
  silently, when the user sends another prompt, Chat still uses the last
  successful session note plus recent raw turns instead of blocking on a forced
  refresh, and newer raw turns take precedence over stale note content.
- AE5. **Covers R19, R20, R20a.** Given the user clicks Save as Note, when the
  normal Note is created, later session note refreshes do not alter that saved
  Note, and Chat provides a clear path to the saved editable Note.
- AE6. **Covers R21.** Given a session has a session note, when the user deletes
  the session, the derived session note is deleted with it and does not remain
  hidden elsewhere.
- AE7. **Covers R4b.** Given an unsaved session note exists, when the user
  searches Explorer or starts an unrelated chat, that unsaved session note is not
  returned as normal workspace context unless it has been saved as a normal Note
  snapshot.
- AE8. **Covers R22.** Given the user opens the session-note surface, when they
  navigate by keyboard or assistive technology, the note's read-only derived
  status and Save as Note action are discoverable without pointer-only controls.

---

## Success Criteria

- A long chat session remains usable without sending unbounded raw history to
  the provider.
- A user can open a session and read the latest successful compact working
  document for the conversation without reading the whole transcript.
- Session note updates never make normal chat feel slower or blocked.
- Users can preserve a useful session note as an ordinary editable Note when
  they want durable workspace material.
- Planning can implement session-note behavior without re-deciding note
  identity, editability, visibility, failure behavior, or prompt-context usage;
  planning still must specify the exact observable idle-opportunity trigger for
  the committed threshold-coalescing refresh strategy.

---

## Scope Boundaries

- No editable session note in V1.
- No automatic Explorer artifact for the session note.
- No unsaved session note in workspace search/indexing or unrelated chat
  retrieval.
- No second hidden compact summary separate from the session note.
- No per-turn session note version history.
- No user-configurable refresh thresholds in V1.
- No visible update, stale, failed, queue, or retry status in V1.
- No bidirectional sync between a saved normal Note and the session note.
- No writing failed, cancelled, empty, or purely local UI activity into the
  session note.
- No fixed universal template for all session notes.
- No treating session note content as higher-priority instructions.
- No automatic long-term memory extraction from session notes in this scope.

---

## Key Decisions

- Single compact artifact: The session note is both user-visible summary and
  prompt compact context, avoiding divergent hidden and visible summaries.
- Read-only session ownership: The session note belongs to Chat, not Explorer,
  because automatic rewrites and user editing would otherwise conflict.
- Asynchronous threshold refresh: Note updates should improve long-session
  continuity without adding latency to normal chat.
- Complete rewrite over patching: A full LLM rewrite keeps the note coherent and
  lets the structure evolve with the session.
- Snapshot export: Save as Note gives users durable editable output without
  changing the session note's role.

---

## Dependencies / Assumptions

- A configured chat model is available for the session; session note maintenance
  uses the same model and inherits the same privacy posture.
- The full transcript remains the durable session record even though future
  prompts use compact context plus recent raw turns.
- Token thresholds are estimates. Exact counting can be approximate as long as
  refresh behavior is predictable enough for tests and does not block chat.
- This document supersedes the older "live Note as normal editable Note" framing
  in `docs/brainstorms/2026-05-10-cluster-first-agent-chat-requirements.md` for
  session note identity, editability, and Explorer visibility.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10][Technical] Define the exact "idle opportunity" trigger so it is
  observable and testable without surprising users.
- [Affects R16][Technical] Choose the exact number of recent raw turns to include
  with the session note in future prompts.
- [Affects R18][Technical] Define how model changes mid-session affect pending
  or future session note refreshes.
- [Affects R21][Technical] Confirm deletion semantics for session note storage
  once the implementation no longer treats it as a normal Explorer Note.
