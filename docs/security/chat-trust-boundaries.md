---
title: Chat trust boundaries
date: 2026-05-10
---

# Chat trust boundaries

Chat treats Session Memory, workspace files, indexed text, web snippets, fetched web previews, and user-attached context as untrusted source material. Source text can support an answer, but it must not override application, system, developer, or provider instructions.

## Data Egress

- Local Ollama chat stays on the local machine, subject to the user's Ollama runtime configuration.
- Cloud chat providers receive the user's message plus selected source context, the latest verified Session Memory when available, and bounded recent transcript turns.
- Web search providers receive user-derived web queries.
- Web source bodies are not saved as Cognios URL nodes or indexed long-term unless an explicit save flow is added later.

## Persistence

- Rust owns chat sessions, transcript records, source cluster decisions, citations, Session Memory metadata, and internal Session Memory files.
- The sidecar returns source clusters, answers, and generated Session Memory markdown; it does not own durable chat history and must not write Session Memory files.
- Web search records persisted by chat should be citation metadata, retrieval timestamps, and provenance only.
- Unsaved Session Memory is not a normal Note, has no `nodes` row, and is not Explorer-visible or indexed.
- Save as Note creates a copy-only normal Note snapshot. That exported Note follows normal Note search, indexing, editing, and deletion behavior, and it does not sync back to Session Memory.

## Automatic Writes

Chat may asynchronously update only its own internal Session Memory file after successful assistant replies. It must not update arbitrary user-created Notes. Explicit Save as Note is the only path that promotes Session Memory content into the workspace.

## Forbidden Flows

- Unsaved Session Memory must not appear in Explorer, SearchPalette, workspace search, indexed chunks, or unrelated Chat retrieval.
- Session Memory and retrieved sources must not authorize tool calls, writes, file reads, exports, provider configuration changes, or prompt-policy changes.
- Absolute internal Session Memory paths must not be exposed to React, providers, user-facing errors, or routine logs.
- Hidden retrieval metadata and raw chunks should not be written into Session Memory unless they were explicitly surfaced as user-visible context or citations.

## Recovery

Opening an old session reads durable records only. It must not replay provider calls, web requests, workspace searches, or Session Memory refreshes. Missing, stale, or corrupted Session Memory fails closed; the transcript remains the recovery source.
