---
date: 2026-05-11
topic: voice-note
focus: automatic voice notes with system-audio detection, Qwen3-ASR, speaker diarization, and LanceDB indexing
mode: repo-grounded
---

# Ideation: Voice Note

## Grounding Context

CogniOS is a local-first desktop memory app built on Tauri v2, Rust, React/TypeScript, SQLite, and a Python FastAPI search sidecar.

Relevant existing surfaces:

- Notes are first-party `note` nodes. The markdown body is stored at `~/.cogios/notes/{id}.md`, and Rust exposes create/get/save note IPC.
- The search sidecar owns `~/.cogios/search/`, model download/status, provider settings, persistent indexing queue state, and LanceDB chunks.
- LanceDB chunks already include node identity, kind, name, text, vector, role (`body`, `summary`, `metadata`), timestamps, and `content_version`.
- Rust forwards node mutation events to the sidecar, which lets new content become searchable without making the UI wait for indexing.
- Current Tauri capabilities allow the `search-sidecar` binary, but the repo does not currently include a native notification plugin.

External grounding:

- Qwen3-ASR-0.6B supports language identification and ASR across 52 languages/dialects, with offline and streaming inference. The official model card notes that streaming is currently vLLM-backend-only and does not return timestamps.
- Qwen3-ForcedAligner-0.6B is a separate model for word/character timestamp alignment after text exists.
- macOS system audio capture should be researched around ScreenCaptureKit; Windows around WASAPI loopback recording; Linux around PipeWire/XDG portal.
- LanceDB supports vector search, metadata filtering, and newly inserted vectors can be searched before approximate indexing completes through brute-force fallback paths.

User constraint:

- Qwen3-ASR should reuse the existing model download capability. When the user opens the app, CogniOS should start downloading the ASR model through the current ModelManager-style path. When the download completes and the model is verified/ready, voice note capture should automatically become available. Do not build a separate model-management system for voice notes.

## Topic Axes

- Capture and consent trigger
- Voice note lifecycle and storage
- Real-time ASR and speaker diarization
- Transcript indexing/search semantics
- Privacy, reliability, and failure recovery

## Ranked Ideas

### 1. Model-Ready Automatic Activation

**Description:** Add `audio-transcript` as a first-class model role managed by the existing search sidecar ModelManager. On app open, the sidecar starts downloading and verifying Qwen3-ASR-0.6B just like other local model roles; once ready, voice note capture automatically turns on. If the model is still downloading, the UI should show voice notes as preparing rather than asking the user to manually install or configure the model.

**Axis:** Privacy, reliability, and failure recovery

**Basis:** `direct:` existing sidecar model manager already owns downloaded/pinned local model roles; `direct:` older model-status requirements mention a future `audio-transcript` role; `external:` Qwen3-ASR-0.6B is the requested local ASR model.

**Rationale:** This is the architectural anchor. It keeps voice notes consistent with CogniOS's local-first search/model system and satisfies the user's explicit constraint that opening the app downloads the model and readiness automatically enables the feature.

**Downsides:** Qwen3-ASR's official Python/vLLM path may pressure the current sidecar runtime packaging. Model size, GPU/CPU behavior, and platform support need a spike before promising seamless first-run UX.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

### 2. Consent Countdown With Optional Pre-Roll

**Description:** Detect sustained system audio playback, then show a short countdown prompt before starting a voice note. A small in-memory pre-roll buffer can preserve the beginning of the meeting only if the user accepts before the countdown ends. Because the repo has no notification plugin today, the first version should use an in-app Tauri prompt or compact always-on overlay; native notifications can follow after capability and permission decisions are settled.

**Axis:** Capture and consent trigger

**Basis:** `direct:` the repo has no notification plugin dependency; `external:` system audio capture is OS-specific via ScreenCaptureKit/WASAPI/PipeWire-style mechanisms; `reasoned:` automatic recording without a consent surface is a trust failure.

**Rationale:** The feature has to feel automatic without feeling covert. Countdown consent is the smallest product surface that preserves user control while still catching meetings they did not manually start.

**Downsides:** OS-level audio detection is the hardest native integration. Pre-roll must be designed carefully so it is memory-only before consent and never becomes silent background recording.

**Confidence:** 86%

**Complexity:** High

**Status:** Unexplored

### 3. Voice Note As Source-Bound Note Package

**Description:** Create a normal CogniOS `note` node when capture starts, then bind source audio, transcript markdown, and session metadata to that note. The current flat `~/.cogios/notes/{id}.md` layout may need a compatible companion directory such as `~/.cogios/notes/{id}/` or `~/.cogios/voice-notes/{id}/` for audio, metadata, partial segments, and recovery checkpoints. The markdown body remains the readable/editable note surface; the source audio is the durable evidence and reprocessing source.

**Axis:** Voice note lifecycle and storage

**Basis:** `direct:` existing notes are first-party nodes and already flow through create/get/save IPC; `reasoned:` ASR output is fallible, so source audio must survive as an audit and retry artifact.

**Rationale:** This avoids creating a parallel "recordings" subsystem. Voice notes behave like notes in Explorer and search, while keeping enough artifact structure for replay, re-transcription, diarization, and failure recovery.

**Downsides:** The existing note storage contract is a single markdown file. A companion artifact layout needs a deliberate migration-compatible design so normal note reads stay simple.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored

### 4. Live Draft, Offline Final

**Description:** During capture, use Qwen3-ASR-0.6B to stream provisional transcript text into the voice note. After recording ends, run a finalization pass that reconciles partial chunks, optionally reruns ASR on the saved audio, and uses Qwen3-ForcedAligner-0.6B for timestamps when available. The live path optimizes for immediacy; the offline path optimizes for correctness and replay anchors.

**Axis:** Real-time ASR and speaker diarization

**Basis:** `external:` Qwen3-ASR supports streaming/offline inference but streaming currently does not return timestamps; `external:` Qwen3-ForcedAligner is a separate timestamp model; `direct:` CogniOS already has sidecar background processing and persistent queues.

**Rationale:** It gives the user live notes without forcing timestamp precision into a fragile real-time loop. It also gives the system a clean place to improve quality after the meeting without changing what the user saw live.

**Downsides:** Users may see text change after finalization. The product needs clear status language so provisional/final transcript states do not feel like data corruption.

**Confidence:** 90%

**Complexity:** High

**Status:** Unexplored

### 5. Speaker Labels As Editable Diarization Layer

**Description:** Treat speaker recognition as a separate diarization layer that initially labels turns as `Speaker 1`, `Speaker 2`, etc. The user can later rename, merge, or correct speakers. Store speaker IDs, confidence, and segment ownership separately from transcript text, then render them into markdown for readability and into LanceDB metadata for retrieval.

**Axis:** Real-time ASR and speaker diarization

**Basis:** `external:` Qwen3-ASR provides ASR and language identification, not guaranteed speaker diarization; `reasoned:` system audio mixes are messy, and user-editable speaker labels preserve value without overclaiming identity recognition.

**Rationale:** The user's "识别不同的对话者" requirement is important, but the right promise is stable speaker separation first, real names only after user correction or later speaker-profile work.

**Downsides:** Needs a diarization model or embedding strategy that is not yet part of the repo. Cross-session speaker identity should be deferred unless explicitly brainstormed.

**Confidence:** 82%

**Complexity:** High

**Status:** Unexplored

### 6. Index Conversation Structure, Not One Big Transcript

**Description:** Index transcript segments as structured chunks in the existing LanceDB-backed search system. Each chunk should carry note ID, speaker label, language, coarse/final time range, source audio reference, transcript status, and maybe a future `audio-transcript` role. This allows search to retrieve the relevant spoken segment rather than only returning the entire note.

**Axis:** Transcript indexing/search semantics

**Basis:** `direct:` the existing LanceDB schema has chunks, roles, node IDs, vectors, and metadata; `external:` LanceDB supports vector search and metadata filtering; `reasoned:` spoken notes are retrieval-heavy, and segment structure is more useful than flattening an hour-long meeting.

**Rationale:** This is where voice notes become CogniOS memory, not just recordings. Search can answer "what did Speaker 2 say about launch risk?" because the transcript preserves conversation structure in the index.

**Downsides:** The current `role` type is limited to `body`, `summary`, and `metadata`; adding `audio-transcript` may require schema/code updates. Real-time indexing while recording also needs careful batching to avoid excessive churn.

**Confidence:** 89%

**Complexity:** Medium

**Status:** Unexplored

### 7. Recoverable Local Pipeline With Audit Trail

**Description:** Model voice notes as a sequence of recoverable local stages: model downloading, ready, detecting, countdown, capturing, transcribing, diarizing, aligning, indexing, done, or failed. The note/session metadata should record the capture backend, user consent event, audio path, ASR model revision, diarization status, alignment status, and LanceDB indexing status. If ASR or indexing fails, the note still exists with source audio and retry state.

**Axis:** Privacy, reliability, and failure recovery

**Basis:** `direct:` the sidecar already has a persistent queue, node mutation events, model status, and lifecycle state; `reasoned:` long audio capture has many failure points, so the source audio must be the recovery anchor and the note must tell the user what happened.

**Rationale:** Automatic voice notes are a trust-heavy feature. A visible audit trail makes failures recoverable and privacy posture inspectable instead of burying capture/indexing behavior in logs.

**Downsides:** More state can create UI clutter. The brainstorm should decide which state belongs in the note body, inspector, and settings/status surfaces.

**Confidence:** 87%

**Complexity:** Medium

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Native OS notification first | The repo has no notification plugin today; in-app prompt is the lower-risk first surface. |
| 2 | Perfect timestamped live transcript | Qwen3-ASR streaming currently does not return timestamps; timestamps belong in a later alignment pass. |
| 3 | Separate ASR downloader/service | Violates the user's constraint to reuse existing model download capability and auto-enable when ready. |
| 4 | Speaker real-name identification in v1 | Diarization can separate voices; real identity is a stronger claim that needs user correction or separate speaker-profile design. |
| 5 | Store only markdown transcript | Fails the source-file requirement and weakens recovery/correction. |
| 6 | Full retention policy matrix as a top idea | Important, but better handled in brainstorm as privacy requirements under the recoverable local pipeline. |
| 7 | Cross-session speaker memory | Potentially valuable but scope-expanding and privacy-sensitive; defer until the basic voice note path is defined. |
| 8 | Search only after recording completes | Lower value than segment-level indexing and unnecessary if batching through existing sidecar queues is viable. |

## Recommended Brainstorm Seed

Start with **Model-Ready Automatic Activation** as the framing idea, then pull in the consent countdown and note package as core requirements. This makes the user's latest constraint load-bearing and prevents the design from drifting into a one-off voice subsystem.

## Sources

- [Qwen/Qwen3-ASR-0.6B model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)
- [Qwen3-ASR Technical Report](https://arxiv.org/abs/2601.21337)
- [LanceDB Managing Embeddings](https://docs.lancedb.com/embedding)
- [LanceDB Vector Search](https://docs.lancedb.com/search/vector-search)
- [Apple ScreenCaptureKit documentation](https://developer.apple.com/documentation/screencapturekit)
- [Microsoft WASAPI Loopback Recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [PipeWire Portal Access Control](https://docs.pipewire.org/devel/page_portal.html)
- [XDG Desktop Portal ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html)

