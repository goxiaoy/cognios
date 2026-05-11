---
date: 2026-05-11
topic: voice-note
---

# Voice Note

## Summary

Voice Note adds a meeting-focused recording workflow to CogniOS: users can start a voice note manually, or let CogniOS detect meeting audio and start after a cancellable countdown. Each voice note keeps local source audio, produces a speaker-separated transcript, then generates summary/action items and indexes the finished transcript into CogniOS search.

---

## Problem Frame

The current workaround is meeting-software transcription. That solves raw speech-to-text, but the output lives outside CogniOS: it is not tied to a local source audio file, does not follow CogniOS note semantics, is not indexed as part of the user's memory substrate, and cannot reliably feed the existing local-first search and chat workflows.

The painful case is a meeting or call where the user wants a durable record but either forgets to start note-taking or does not want to manually shuttle a transcript from Zoom/Meet/Teams into CogniOS afterward. The feature should make capture easy without making recording feel covert, and it should preserve recovery paths when local models are not ready yet.

---

## Actors

- A1. User: Starts, cancels, stops, reviews, edits, and searches voice notes.
- A2. CogniOS desktop app: Detects likely meeting audio, presents the countdown/manual controls, records system audio, and creates the note surface.
- A3. CogniOS model/search subsystem: Downloads local ASR models, transcribes audio, runs post-processing, and indexes completed transcripts.
- A4. Existing chat/provider configuration: Generates summary and action items when a suitable provider is available.

---

## Key Flows

- F1. Manual voice note
  - **Trigger:** The user starts a voice note from CogniOS.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** CogniOS creates a voice note, records system audio, tracks coarse segment timing, stops when the user ends the session, transcribes when possible, separates speakers, generates meeting outputs when provider support exists, and indexes the finished transcript.
  - **Outcome:** The user has a local voice note with source audio, transcript, speaker turns, summary/action items when available, and searchable transcript content.
  - **Covered by:** R1, R4, R5, R6, R7, R8, R9, R10

- F2. Detected meeting voice note
  - **Trigger:** CogniOS detects likely meeting/call audio while voice note capture is enabled.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** CogniOS shows a cancellable countdown, starts automatically if the countdown completes, then follows the same capture and post-processing path as a manual voice note.
  - **Outcome:** Meetings the user forgot to start manually can still become voice notes without removing the user's chance to cancel.
  - **Covered by:** R2, R3, R4, R5, R6, R7, R8, R9, R10

- F3. Model not ready
  - **Trigger:** A voice note starts while the ASR model is missing, downloading, verifying, or otherwise not ready.
  - **Actors:** A1, A2, A3
  - **Steps:** CogniOS still records source audio and creates the voice note, marks transcription as pending, and automatically resumes transcription once the model becomes ready.
  - **Outcome:** The meeting record is not lost because model readiness lagged behind capture.
  - **Covered by:** R4, R5, R11, R12

- F4. Review and cleanup
  - **Trigger:** The user opens a completed or partially completed voice note.
  - **Actors:** A1, A2, A3
  - **Steps:** The user reviews transcript, speaker labels, summary/action items, capture status, and audio retention state; the user may rename speakers within the note or delete the source audio.
  - **Outcome:** The note remains useful and searchable while the user controls sensitive source audio retention.
  - **Covered by:** R6, R7, R8, R9, R13, R14

---

## Requirements

**Entry points and capture**

- R1. Voice Note v1 must support manual start. The user can create a voice note without waiting for automatic audio detection.
- R2. Voice Note v1 must support automatic meeting/call detection as a convenience path. Detection should target likely meetings or calls, not every long-playing audio source.
- R3. When automatic detection fires, CogniOS must show a cancellable countdown. If the countdown completes without cancellation, recording starts automatically.
- R4. CogniOS must record source audio for each voice note and treat that audio as the recovery source for transcription and later reprocessing.

**Model readiness and transcription**

- R5. Qwen3-ASR must be managed through the existing model download/status capability rather than a separate voice-note downloader. CogniOS should begin preparing the ASR model when the app opens, and voice note transcription becomes available automatically once the model is ready.
- R6. If recording starts before the ASR model is ready, CogniOS must still create the voice note and save source audio. Transcription is marked pending and starts automatically when the model becomes ready.
- R7. Voice Note v1 must produce a transcript from CogniOS's own recording path. Meeting-software transcripts are not the primary input for v1.
- R8. Voice Note v1 must separate transcript content into anonymous speaker turns such as `Speaker 1` and `Speaker 2`. It must not claim to know real speaker identities.
- R9. Users must be able to rename speaker labels within a single voice note. Those names do not become cross-meeting voice profiles in v1.
- R10. Voice Note v1 must preserve coarse segment timing suitable for jumping near a spoken section. It must not promise real-time precise word-level timestamps or synchronized word highlighting.

**Post-processing and search**

- R11. After recording ends, the completed transcript should be indexed into CogniOS search/LanceDB. v1 does not need to index transcript chunks while recording is still active.
- R12. Voice Note completion should produce a readable meeting artifact: transcript, speaker-separated sections, summary, and action items.
- R13. Summary and action-item generation should reuse the existing chat/provider configuration. If no suitable provider is available, the voice note still completes with source audio, transcript, speaker turns, and search indexing; summary/action items may remain pending or unavailable.

**Retention, privacy, and recovery**

- R14. Source audio is retained locally by default. Each voice note must provide a clear action to delete its source audio.
- R15. Deleting source audio must not delete the transcript or search index by default, but the user must understand that replay, re-transcription, and future alignment from the original audio are no longer available.
- R16. Voice notes must expose processing state clearly enough for the user to distinguish recording, transcription pending, transcribing, speaker processing, summarizing, indexing, completed, and failed/retryable states.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R7, R11, R12.** Given the ASR model is ready, when the user manually starts and stops a voice note during a meeting, CogniOS saves source audio, creates a transcript, separates speakers, generates summary/action items when provider support exists, and indexes the finished transcript.
- AE2. **Covers R2, R3.** Given CogniOS detects likely meeting audio, when the countdown appears and the user cancels, no voice note recording starts.
- AE3. **Covers R2, R3, R4.** Given CogniOS detects likely meeting audio, when the countdown completes without cancellation, CogniOS starts recording automatically and creates a voice note.
- AE4. **Covers R5, R6.** Given the ASR model is still downloading when a meeting starts, when recording begins, CogniOS saves source audio and marks transcription pending; when the model becomes ready, transcription starts without requiring the user to recreate the note.
- AE5. **Covers R8, R9.** Given a completed two-person meeting transcript, when the user opens the voice note, turns are separated as anonymous speakers and the user can rename `Speaker 1` inside that note.
- AE6. **Covers R10.** Given a completed voice note, when the user jumps from a transcript segment to audio, the app jumps near that segment; the UI does not imply word-level timestamp precision.
- AE7. **Covers R13.** Given no usable summary provider is configured, when transcription completes, the voice note still has transcript, speaker sections, and search indexing, while summary/action items are unavailable or pending.
- AE8. **Covers R14, R15.** Given a completed voice note with retained source audio, when the user deletes the audio, transcript and search remain, but replay and reprocessing from the original source are no longer available.

---

## Success Criteria

- A user who currently relies on meeting-software transcription can instead create or automatically receive a CogniOS voice note and find it later through CogniOS search.
- Missing ASR model readiness does not cause a missed meeting record; source audio is captured first and transcription can catch up.
- Completed voice notes are useful meeting artifacts, not just raw transcripts: speaker-separated transcript, summary, and action items are visible when available.
- Privacy posture is understandable: source audio is local, retained by default, and deletable per note.
- A planner can proceed without inventing the v1 product behavior around triggers, model readiness, source audio retention, speaker identity, summary generation, search timing, or timestamp precision.

---

## Scope Boundaries

- No cross-meeting voiceprint library or automatic real-person identification in v1.
- No import path for Zoom/Meet/Teams built-in transcripts as the primary workflow.
- No search of words spoken while the recording is still active.
- No real-time precise word-level timestamps or synchronized word highlighting.
- No requirement that native OS notifications ship in v1; an in-app prompt is acceptable if it satisfies the countdown behavior.
- No advanced audio retention policy matrix such as automatic deletion after a time period or per-meeting-type retention rules.
- No product-level commitment to all long-form audio such as podcasts, lectures, or videos. v1 is optimized for meetings/calls.

---

## Key Decisions

- Manual start plus automatic detection: manual start is the reliable primary entry point; automatic detection reduces missed meetings.
- CogniOS-owned recording is the v1 source of truth: meeting-software transcripts are a workaround today, but v1 should not depend on vendor export behavior.
- Record before model readiness: source audio is more important than immediate transcription when the ASR model is not ready.
- Anonymous speaker separation first: useful meeting structure matters, but real identity recognition is too error-prone and privacy-sensitive for v1.
- End-of-recording indexing: v1 optimizes for stable completed voice notes instead of live search while recording.
- Retain source audio by default: replay, correction, re-transcription, and alignment are valuable enough to keep audio unless the user deletes it.
- Reuse existing provider configuration for summaries: voice notes should not introduce a separate cloud/local LLM configuration surface.

---

## Dependencies / Assumptions

- The existing model download/status system can be extended with an ASR role for Qwen3-ASR.
- The existing chat/provider configuration can be reused for summary and action-item generation.
- The search sidecar can index completed transcript content after recording ends.
- Platform audio capture feasibility differs by OS and must be validated during planning.
- Qwen3-ASR streaming does not provide timestamp output; precise timestamps require a post-recording alignment path if that enhancement is added.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2-R4][Needs research] Which OS audio capture path should v1 target first, and what permission prompts or platform limitations apply?
- [Affects R5-R7][Needs research] What runtime shape can run Qwen3-ASR reliably inside the current local sidecar packaging constraints?
- [Affects R8-R9][Needs research] Which local diarization approach is viable for anonymous speaker turns without adding cross-meeting identity memory?
- [Affects R10][Technical] What coarse segment duration gives useful audio jumps without implying word-level precision?
- [Affects R11][Technical] How should completed transcript indexing batch speaker/time metadata while fitting existing search semantics?
- [Affects R13][Technical] Which existing provider capabilities are sufficient for summary/action-item generation, and what fallback state should appear when none are configured?
- [Affects R14-R15][Technical] What exact audio deletion behavior is needed to remove local source audio while preserving transcript/search state?
