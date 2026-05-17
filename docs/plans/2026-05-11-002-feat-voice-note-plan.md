---
title: "feat: Add Voice Note foundation"
type: feat
status: implemented
date: 2026-05-11
origin: docs/brainstorms/2026-05-11-voice-note-requirements.md
---

# feat: Add Voice Note foundation

## Summary

Implement the first Voice Note foundation as a meeting-focused, local-first note workflow: the user can manually create a voice note, CogniOS tracks source-audio/transcription lifecycle state, the ASR model role is exposed through the existing model readiness system, completed transcripts can be saved into normal note content, and the search index picks them up after completion. Native meeting-audio detection and full Qwen/diarization execution are planned as follow-up implementation units once platform/runtime feasibility is validated.

## Problem Frame

The origin requirements define Voice Note as a way to bring meeting records into CogniOS's local memory substrate. The current workaround is meeting-software transcription, but that transcript lives outside CogniOS and is not tied to local source audio, note semantics, search, or chat/provider workflows.

The highest-risk parts are native system-audio capture, Qwen3-ASR runtime packaging, and local diarization. The repo has strong local patterns for notes, model download/status, sidecar events, indexing, and provider-backed summarization, but it does not yet have an audio capture subsystem. The implementation should therefore land durable product scaffolding and interfaces first, while preventing the UI from claiming capture/transcription capabilities that are not actually wired.

## Plan Requirements

- PR1. Manual voice note creation is the first supported entry point from the origin's R1/F1.
- PR2. Automatic meeting detection remains in scope architecturally, but the first code path must expose it as unavailable/pending research rather than silently recording.
- PR3. Voice notes are normal CogniOS notes with additional local metadata and processing state, preserving Explorer/search compatibility.
- PR4. Source audio is treated as the recovery source; transcript and search content are rebuildable derivatives.
- PR5. The ASR model role is surfaced through existing model status/download concepts rather than a separate downloader.
- PR6. If ASR is unavailable, a voice note can exist in a pending transcription state.
- PR7. v1 transcript content is indexed only after completion, via existing note save and node-change indexing paths.
- PR8. Speaker labels are anonymous and local to a voice note.
- PR9. Summary/action-item generation should reuse existing chat/provider infrastructure, with unavailable/pending state when no provider is configured.
- PR10. The UI must be honest about unsupported capture/transcription backends.

**Origin mapping:** PR1 maps R1; PR2 maps R2-R3; PR3-PR4 map R4, R14-R16; PR5-PR6 map R5-R6; PR7 maps R7 and R11; PR8 maps R8-R10; PR9 maps R12-R13; PR10 preserves the scope boundaries around native notifications, live search, and timestamp precision.

## Scope Boundaries

- No real system-audio recording in the first foundation slice unless the implementation spike proves a native path within the same work. The UI must not claim it is recording if it is not.
- No automatic meeting detection implementation in the first foundation slice; it remains a planned capability behind disabled/unavailable state.
- No Qwen3-ASR inference runtime bundled in the first foundation slice. The ASR role and readiness state can be modeled before runtime execution is integrated.
- No diarization model integration in the first foundation slice. Anonymous speaker labels can be represented in transcript data, but automatic separation waits for a processor.
- No cross-meeting voiceprint identity, meeting-transcript import, live search while recording, or word-level timestamp synchronization.
- No new cloud/provider configuration surface for summaries.

## Existing Patterns To Follow

- Normal note creation/save/read lives in `src-tauri/src/commands/notes.rs` and `src-tauri/src/services/notes/`.
- Explorer note activation and editor integration live in `src/features/explorer/components/ExplorerLayout.tsx` and `src/features/explorer/components/NoteEditor.tsx`.
- Model readiness/download is exposed through `sidecar/search_sidecar/models/manager.py`, `sidecar/search_sidecar/models/manifest.py`, `sidecar/search_sidecar/routes/models.py`, `src-tauri/src/services/search/client.rs`, `src/lib/contracts/search.ts`, and `src/app/hooks/useAutoModelDownload.ts`.
- Local indexing already follows note save -> Rust event -> sidecar queue -> LanceDB through `src-tauri/src/services/search/forwarder.rs` and `sidecar/search_sidecar/routes/events.py`.
- Chat/provider generation is orchestrated by `sidecar/search_sidecar/chat/orchestrator.py` and surfaced through `src-tauri/src/commands/chat.rs` / `src/features/chat/`.
- Settings/model status UI patterns live in `src/features/settings/components/` and provider presets in `src/features/settings/data/providerPresets.ts`.

## Key Technical Decisions

- **Land a foundation slice before native capture.** This keeps the product honest: users can create and inspect voice notes and see readiness states, but unsupported capture/ASR paths are marked unavailable until the platform/runtime work is proven.
- **Represent voice notes as normal notes plus metadata.** Reusing notes keeps Explorer, note editing, and search behavior consistent. Metadata captures voice-note state without inventing a parallel artifact system.
- **Use the existing indexing event path.** Completed transcript text should be saved into the note body so the existing note indexing path picks it up after completion.
- **Expose `audio-transcript` as a model role but avoid fake readiness.** The UI can show that ASR is missing/downloading/unavailable. If the manifest cannot be pinned safely in this slice, the role should not be auto-started as if it were runnable.
- **Make unsupported capabilities visible, not hidden.** Automatic detection and system audio recording should show a clear disabled/pending state until implemented, so downstream work cannot confuse scaffolding with completed capture support.
- **Keep summary generation optional.** Voice notes complete without summary/action items if no provider is configured; summary integration can reuse provider-backed generation once transcript text exists.

## Implementation Units

### U1: Voice note domain metadata and commands

**Goal:** Add durable voice-note lifecycle metadata tied to normal note nodes.

**Files:**
- Modify: `src-tauri/migrations/mod.rs`
- Add: `src-tauri/migrations/0007_voice_notes.sql`
- Add: `src-tauri/src/domain/voice_note/mod.rs`
- Add: `src-tauri/src/services/voice_notes/mod.rs`
- Add: `src-tauri/src/commands/voice_notes.rs`
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/tests/voice_notes.rs`

**Approach:**
- Create a voice-note metadata table keyed by the normal note node id.
- Record lifecycle state such as pending audio, pending transcription, transcribing, completed, failed, source-audio-present, transcript status, coarse timing availability, and speaker-label metadata.
- Provide commands to create a manual voice note, read voice-note metadata, update transcript content, mark processing states, rename local speaker labels, and delete source audio metadata/path when audio exists.
- Manual voice note creation should create a normal note first, then attach voice metadata.
- Until real audio capture lands, manual creation should produce a pending/no-audio state rather than pretending capture occurred.

**Test Scenarios:**
- Creating a voice note creates a normal note and a voice metadata row.
- A voice note can transition from pending transcription to completed after transcript content is saved.
- Deleting source audio state preserves transcript/note content.
- Renaming a speaker label affects only that voice note metadata.
- Invalid state transitions fail without corrupting the note.

### U2: Frontend contracts and manual Voice Note surface

**Goal:** Give the user a visible manual entry point and honest processing state.

**Files:**
- Modify: `src/lib/contracts/vfs.ts`
- Modify: `src/lib/tauri/ipc.ts`
- Add: `src/lib/contracts/voiceNote.ts`
- Add: `src/features/voice-notes/api/voiceNoteClient.ts`
- Add: `src/features/voice-notes/components/VoiceNotePanel.tsx`
- Add: `src/features/voice-notes/components/VoiceNotePanel.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/AppSidebar.tsx`
- Modify: `src/styles/app.css`

**Approach:**
- Add a Voice Notes section or panel with a manual "New voice note" action.
- Show model readiness, capture support, source-audio state, transcript status, and indexing/summarization state.
- Show automatic detection as unavailable/pending in the first slice, with wording that does not imply background recording.
- After manual creation, route the user to the created note or show the created voice note in the panel with its current state.
- Follow the app's compact operational UI style rather than a landing page.

**Test Scenarios:**
- Voice Notes panel renders manual start and disabled automatic detection state.
- Creating a voice note calls the client and displays the resulting pending state.
- The panel distinguishes ASR missing/downloading/ready states.
- Unsupported capture state is visible and does not claim active recording.

### U3: ASR model role readiness integration

**Goal:** Surface `audio-transcript` readiness through existing model status patterns without starting a fake runtime.

**Files:**
- Modify: `sidecar/search_sidecar/models/manifest.py`
- Modify: `src/lib/contracts/search.ts`
- Modify: `src/features/settings/data/providerPresets.ts`
- Modify: `src/app/hooks/useAutoModelDownload.ts`
- Modify: `src/features/settings/components/ModelManagerStatus.tsx` if present, or the current model-status component equivalent.
- Test: `sidecar/tests/test_models.py`
- Test: `src/app/hooks/useAutoModelDownload.test.tsx` if present, or adjacent Settings/model tests.

**Approach:**
- Add a role concept for audio transcription only if the manifest can represent Qwen3-ASR files with safe pins. If exact pins are not available during implementation, keep `audio-transcript` out of auto-download and represent ASR support as unavailable rather than fake-ready.
- Extend frontend role ordering/display so `audio-transcript` appears predictably once present.
- Ensure auto-download only attempts roles owned by enabled local providers and skips roles not in the manifest or intentionally unavailable.

**Test Scenarios:**
- Model status can include an unknown/future role without random ordering.
- Auto-download does not crash when `audio-transcript` is absent/unavailable.
- If `audio-transcript` is present and missing, the UI displays it as missing/downloading/ready like other roles.

### U4: Completed transcript save and search handoff

**Goal:** Use existing note save and indexing paths for completed transcript content.

**Files:**
- Modify: `src-tauri/src/services/voice_notes/mod.rs`
- Modify: `src-tauri/src/commands/voice_notes.rs`
- Test: `src-tauri/tests/voice_notes.rs`
- Test: `src-tauri/tests/notes_commands.rs`

**Approach:**
- Provide a command that saves a completed transcript into the note body in a readable meeting-note format.
- Include speaker-separated sections, coarse segment markers when present, and pending/unavailable summary/action item sections when provider generation is unavailable.
- Emit the same node-saved/change event used by normal notes so the search sidecar indexes the completed transcript after recording/transcription completion.

**Test Scenarios:**
- Saving a completed transcript writes note markdown.
- The note save emits indexing events through the existing emitter path.
- Completed transcript search handoff does not require live indexing while recording.

### U5: Summary/action item generation path

**Goal:** Add an optional summarization hook that reuses existing provider configuration without blocking voice-note completion.

**Files:**
- Modify: `sidecar/search_sidecar/chat/orchestrator.py`
- Modify: `sidecar/search_sidecar/routes/chat.py`
- Modify: `src-tauri/src/services/search/client.rs`
- Modify: `src-tauri/src/commands/voice_notes.rs`
- Test: `sidecar/tests/test_chat_routes.py`
- Test: `src-tauri/tests/voice_notes.rs`

**Approach:**
- Add a provider-backed operation for turning transcript text into summary/action items, or reuse an existing chat turn pathway with a voice-note-specific prompt.
- Treat provider unavailable/error as a non-fatal voice-note state.
- Persist summary/action item text into the note only when generation succeeds.

**Test Scenarios:**
- Provider unavailable returns a pending/unavailable summary state without failing transcript completion.
- Provider success adds summary and action items to the voice note body.
- Provider errors are visible and retryable without deleting transcript content.

### U6: Capture/detection research adapters

**Goal:** Prepare the codebase for real capture/detection without shipping fake capture.

**Files:**
- Add: `src-tauri/src/services/voice_notes/capture.rs`
- Test: `src-tauri/tests/voice_notes.rs`

**Approach:**
- Define a capture capability interface and an unavailable implementation that returns a typed unsupported state.
- Keep platform-specific ScreenCaptureKit/WASAPI/PipeWire work deferred to a follow-up plan unit once research validates target OS and permissions.
- Wire the frontend to display unsupported/pending state cleanly.

**Test Scenarios:**
- Capture unavailable returns a typed state and does not create fake audio.
- Automatic detection unavailable does not start recording.

### U7: Verification

**Goal:** Prove the foundation is durable, honest, and compatible with existing note/search patterns.

**Verification run:**
- `cargo fmt --manifest-path src-tauri/Cargo.toml`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `git diff --check`
- `cargo test --manifest-path src-tauri/Cargo.toml --test voice_notes`
- `cargo test --manifest-path src-tauri/Cargo.toml --test vfs_events`
- `npm test -- src/features/voice-notes/components/VoiceNotePanel.test.tsx src/app/App.test.tsx`
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`

**Not run:**
- `cd sidecar && uv run pytest tests/test_models.py tests/test_chat_routes.py -q` because this foundation slice does not change the sidecar model/chat runtime.
- `ce-test-browser mode:pipeline` because the required `agent-browser` CLI is not installed in this environment.

## Implementation Notes

- Implemented manual voice-note creation as normal note creation plus `voice_notes` metadata in migration `0007`; voice-note creation emits `node-created` only after metadata insertion succeeds.
- Completed transcript updates only the managed voice-note sections inside Markdown, preserving user-written note content and emitting `node-saved` after metadata completion so LanceDB indexing sees durable completed state.
- Added an honest capture capability response that marks system audio recording and meeting detection as unsupported in this build.
- Surfaced the reserved `audio-transcript` role in frontend contracts and the Voice Notes panel without adding a fake sidecar manifest entry or auto-download path.
- Kept summary/action items non-blocking: completed transcripts can include supplied summary/action items, otherwise summary remains unavailable.

## Sequencing

1. U1: Add backend voice-note metadata and commands.
2. U2: Add frontend Voice Notes surface and contracts.
3. U3: Add safe ASR model role/readiness handling.
4. U4: Add completed transcript save/search handoff.
5. U5: Add optional summary/action item generation if provider reuse is straightforward; otherwise keep the explicit pending/unavailable state.
6. U6: Add capture/detection unsupported adapter and UI state.
7. U7: Run targeted verification and build.

## Risks

| Risk | Mitigation |
| --- | --- |
| The foundation feels incomplete without actual recording | Make unsupported capture state explicit and keep source-audio states honest; do not market the slice as full capture |
| Qwen3-ASR packaging is incompatible with current sidecar runtime | Treat ASR runtime as a planning/research follow-up and do not fake readiness |
| Voice metadata duplicates normal note state | Keep the normal note as the user-visible artifact; voice metadata stores only processing/source-audio state |
| Summary generation couples voice notes too tightly to Chat | Use provider-backed generation as optional and non-fatal |
| Future real capture needs schema changes | Store state flexibly enough for source audio and coarse segments without committing to OS-specific capture details |

## Follow-Up Work

- Implement real macOS system-audio capture and meeting detection after a platform spike.
- Add Qwen3-ASR runtime integration once packaging, pins, and hardware behavior are validated.
- Add local diarization for anonymous speaker turns.
- Add forced-alignment post-processing for precise timestamps.
- Add native notification integration if in-app countdown is not sufficient.
