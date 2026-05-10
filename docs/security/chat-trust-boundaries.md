---
title: Chat trust boundaries
date: 2026-05-10
---

# Chat trust boundaries

Chat treats workspace files, indexed text, web snippets, and fetched web previews as untrusted source material. Source text can support an answer, but it must not override application, system, developer, or provider instructions.

## Data Egress

- Local Ollama chat stays on the local machine, subject to the user's Ollama runtime configuration.
- Cloud chat providers receive the user's message plus selected source context.
- Web search providers receive user-derived web queries.
- Web source bodies are not saved as Cognios URL nodes or indexed long-term unless an explicit save flow is added later.

## Persistence

- Rust owns chat sessions, transcript records, source cluster decisions, citations, progress summaries, and the bound live Note id in `cognios.db`.
- The sidecar returns source clusters and answers; it does not own durable chat history.
- Web search records persisted by chat should be citation metadata, retrieval timestamps, and provenance only.

## Automatic Writes

The only automatic content mutation Chat may perform is updating the live Note bound to the current chat session. It must not update arbitrary user-created Notes.

## Recovery

Opening an old session reads durable records only. It must not replay provider calls, web requests, workspace searches, or live Note updates.
