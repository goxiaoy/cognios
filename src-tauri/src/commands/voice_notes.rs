use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::State;

use crate::domain::voice_note::VoiceNoteDto;
use crate::infrastructure::db::connection::Database;
use crate::services::search::{
    SearchSidecarClient, SidecarEnvelope, SidecarEnvelopeState, VoiceNoteTranscriptionRequestDto,
    VoiceNoteTranscriptionResponseDto, VoiceNoteWarmTranscriberResponseDto,
};
use crate::services::voice_notes::native_audio::{CompletedAudioSegment, NativeAudioCapture};
use crate::services::voice_notes::{
    append_voice_note_audio_chunk as append_voice_note_audio_chunk_record,
    append_voice_note_realtime_transcript as append_voice_note_realtime_transcript_record,
    begin_voice_note_audio_capture as begin_voice_note_audio_capture_record, capture_capability,
    complete_voice_note_transcript as complete_voice_note_transcript_record,
    create_voice_note as create_voice_note_record,
    delete_voice_note_source_audio as delete_voice_note_source_audio_record,
    finish_voice_note_audio_capture as finish_voice_note_audio_capture_record,
    get_voice_note as get_voice_note_record,
    get_voice_note_transcript as get_voice_note_transcript_record,
    list_voice_notes as list_voice_notes_record,
    mark_voice_note_capture_failed as mark_voice_note_capture_failed_record,
    mark_voice_note_transcription_failed as mark_voice_note_transcription_failed_record,
    rename_voice_note_speaker as rename_voice_note_speaker_record, AppendRealtimeTranscriptInput,
    AppendVoiceNoteAudioChunkInput, BeginVoiceNoteAudioCaptureInput, CaptureCapabilityDto,
    CompleteVoiceNoteTranscriptInput, CreateVoiceNoteInput, CreatedVoiceNote,
    FinishVoiceNoteAudioCaptureInput, RenameVoiceNoteSpeakerInput, VoiceNoteInput,
};
use crate::{AppState, VfsEventEmitter};

const TRANSCRIPTION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const TRANSCRIPTION_READY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const REALTIME_TRANSCRIPTION_SEGMENT_POLL_INTERVAL: Duration = Duration::from_secs(1);
const REALTIME_TRANSCRIPTION_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const REALTIME_TRANSCRIPTION_READY_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const TRANSCRIBER_WARMUP_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const TRANSCRIBER_WARMUP_READY_TIMEOUT: Duration = Duration::from_secs(2 * 60);

#[tauri::command]
pub fn get_voice_note_capture_capability() -> CaptureCapabilityDto {
    capture_capability()
}

#[tauri::command]
pub fn create_voice_note(
    state: State<'_, AppState>,
    input: CreateVoiceNoteInput,
) -> Result<CreatedVoiceNote, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    create_voice_note_record(&mut conn, &input, &notes_dir, &emitter)
}

#[tauri::command]
pub fn list_voice_notes(state: State<'_, AppState>) -> Result<Vec<VoiceNoteDto>, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_voice_notes_record(&conn)
}

#[tauri::command]
pub fn get_voice_note(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<Option<VoiceNoteDto>, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    get_voice_note_record(&conn, &input.note_id)
}

#[tauri::command]
pub fn get_voice_note_transcript(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<String, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    get_voice_note_transcript_record(&conn, &input.note_id, &notes_dir)
}

#[tauri::command]
pub fn complete_voice_note_transcript(
    state: State<'_, AppState>,
    input: CompleteVoiceNoteTranscriptInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    complete_voice_note_transcript_record(&conn, &input, &notes_dir, &emitter)
}

#[tauri::command]
pub fn begin_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: BeginVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    begin_voice_note_audio_capture_record(&conn, &input, &state.storage_dir, &notes_dir, &emitter)
}

#[tauri::command]
pub fn append_voice_note_audio_chunk(
    state: State<'_, AppState>,
    input: AppendVoiceNoteAudioChunkInput,
) -> Result<(), String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    append_voice_note_audio_chunk_record(&conn, &input)
}

#[tauri::command]
pub fn finish_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: FinishVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    finish_voice_note_audio_capture_with_transcription(&state, input)
}

#[tauri::command]
pub fn begin_native_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: BeginVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let native_input = BeginVoiceNoteAudioCaptureInput {
        note_id: input.note_id.clone(),
        mime_type: Some("audio/wav".to_string()),
        file_extension: Some("wav".to_string()),
    };
    let voice_note = begin_voice_note_audio_capture_record(
        &conn,
        &native_input,
        &state.storage_dir,
        &notes_dir,
        &emitter,
    )?;
    let audio_path = voice_note
        .source_audio_path
        .as_deref()
        .ok_or_else(|| "voice note source audio path is missing".to_string())?;
    if let Err(error) = state
        .voice_note_audio_capture
        .start(&voice_note.note_id, Path::new(audio_path))
    {
        let _ = mark_voice_note_capture_failed_record(&conn, &input.note_id);
        return Err(error);
    }
    spawn_voice_note_transcriber_warmup(Arc::clone(&state.search_client));
    spawn_realtime_voice_note_transcription(
        state.db.clone(),
        notes_dir,
        Arc::clone(&state.emitter),
        Arc::clone(&state.search_client),
        Arc::clone(&state.voice_note_audio_capture),
        voice_note.note_id.clone(),
    );
    Ok(voice_note)
}

#[tauri::command]
pub fn finish_native_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: FinishVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    let elapsed_ms = state.voice_note_audio_capture.stop(&input.note_id)?;
    let duration_ms = Some(elapsed_ms);
    finish_voice_note_audio_capture_with_transcription(
        &state,
        FinishVoiceNoteAudioCaptureInput {
            note_id: input.note_id,
            duration_ms,
        },
    )
}

#[tauri::command]
pub fn pause_native_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<(), String> {
    state.voice_note_audio_capture.pause(&input.note_id)
}

#[tauri::command]
pub fn resume_native_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<(), String> {
    state.voice_note_audio_capture.resume(&input.note_id)
}

fn finish_voice_note_audio_capture_with_transcription(
    state: &AppState,
    input: FinishVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let voice_note = finish_voice_note_audio_capture_record(&conn, &input, &notes_dir, &emitter)?;
    if let Some(audio_path) = voice_note.source_audio_path.clone() {
        spawn_voice_note_transcription(
            state.db.clone(),
            notes_dir,
            Arc::clone(&state.emitter),
            Arc::clone(&state.search_client),
            voice_note.note_id.clone(),
            audio_path,
        );
    }
    Ok(voice_note)
}

#[tauri::command]
pub fn rename_voice_note_speaker(
    state: State<'_, AppState>,
    input: RenameVoiceNoteSpeakerInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    rename_voice_note_speaker_record(&conn, &input)
}

#[tauri::command]
pub fn delete_voice_note_source_audio(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    delete_voice_note_source_audio_record(&conn, &input, &notes_dir, &emitter)
}

fn spawn_voice_note_transcription(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    note_id: String,
    audio_path: String,
) {
    tauri::async_runtime::spawn(async move {
        run_voice_note_transcription_job(
            db,
            notes_dir,
            emitter,
            search_client,
            note_id,
            audio_path,
        )
        .await;
    });
}

fn spawn_realtime_voice_note_transcription(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    audio_capture: Arc<NativeAudioCapture>,
    note_id: String,
) {
    tauri::async_runtime::spawn(async move {
        run_realtime_voice_note_transcription_job(
            db,
            notes_dir,
            emitter,
            search_client,
            audio_capture,
            note_id,
        )
        .await;
    });
}

fn spawn_voice_note_transcriber_warmup(search_client: Arc<SearchSidecarClient>) {
    tauri::async_runtime::spawn(async move {
        warm_voice_note_transcriber(search_client).await;
    });
}

async fn warm_voice_note_transcriber(search_client: Arc<SearchSidecarClient>) {
    let started_at = Instant::now();
    loop {
        match search_client.warm_voice_note_transcriber().await {
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: Some(VoiceNoteWarmTranscriberResponseDto { status, error }),
                ..
            } => match status.as_str() {
                "ready" => return,
                "pending" => {
                    if started_at.elapsed() >= TRANSCRIBER_WARMUP_READY_TIMEOUT {
                        log::debug!(
                            "voice note transcriber warmup timed out waiting for ASR model: {}",
                            error.as_deref().unwrap_or("no detail provided")
                        );
                        return;
                    }
                }
                "unavailable" | "failed" => {
                    log::debug!(
                        "voice note transcriber warmup {}: {}",
                        status,
                        error.as_deref().unwrap_or("no detail provided")
                    );
                    return;
                }
                other => {
                    log::debug!("voice note transcriber warmup returned unknown status: {other}");
                    return;
                }
            },
            SidecarEnvelope {
                state: SidecarEnvelopeState::Initialising,
                ..
            }
            | SidecarEnvelope {
                state: SidecarEnvelopeState::Unavailable,
                ..
            } => {
                if started_at.elapsed() >= TRANSCRIBER_WARMUP_READY_TIMEOUT {
                    log::debug!("voice note transcriber warmup could not reach the search sidecar");
                    return;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: None,
                error,
            } => {
                log::debug!(
                    "voice note transcriber warmup returned no response body: {}",
                    error.as_deref().unwrap_or("no detail provided")
                );
                return;
            }
        }
        tokio::time::sleep(TRANSCRIBER_WARMUP_RETRY_INTERVAL).await;
    }
}

async fn run_realtime_voice_note_transcription_job(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    audio_capture: Arc<NativeAudioCapture>,
    note_id: String,
) {
    loop {
        tokio::time::sleep(REALTIME_TRANSCRIPTION_SEGMENT_POLL_INTERVAL).await;
        drain_realtime_voice_note_segments(
            &db,
            &notes_dir,
            &emitter,
            &search_client,
            &audio_capture,
            &note_id,
        )
        .await;
        if !audio_capture.is_recording_active(&note_id) {
            drain_realtime_voice_note_segments(
                &db,
                &notes_dir,
                &emitter,
                &search_client,
                &audio_capture,
                &note_id,
            )
            .await;
            return;
        }
    }
}

async fn drain_realtime_voice_note_segments(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    search_client: &Arc<SearchSidecarClient>,
    audio_capture: &NativeAudioCapture,
    note_id: &str,
) {
    let segments = match audio_capture.take_completed_segments(note_id) {
        Ok(segments) => segments,
        Err(error) => {
            log::warn!("voice note realtime transcription could not read segments: {error}");
            return;
        }
    };
    for segment in segments {
        let Some(response) =
            transcribe_realtime_voice_note_segment(search_client, note_id, &segment).await
        else {
            continue;
        };
        append_realtime_voice_note_transcript(db, notes_dir, emitter, note_id, &segment, response);
    }
}

async fn transcribe_realtime_voice_note_segment(
    search_client: &SearchSidecarClient,
    note_id: &str,
    segment: &CompletedAudioSegment,
) -> Option<VoiceNoteTranscriptionResponseDto> {
    let started_at = Instant::now();
    loop {
        let request = VoiceNoteTranscriptionRequestDto {
            note_id: note_id.to_string(),
            audio_path: segment.path.clone(),
            language: None,
        };
        match search_client.transcribe_voice_note(&request).await {
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: Some(response),
                ..
            } => match response.status.as_str() {
                "completed" => return Some(response),
                "pending" => {
                    if started_at.elapsed() >= REALTIME_TRANSCRIPTION_READY_TIMEOUT {
                        log::warn!(
                            "voice note realtime segment {} timed out waiting for Qwen ASR",
                            segment.index
                        );
                        return None;
                    }
                }
                "unavailable" | "failed" => {
                    log::warn!(
                        "voice note realtime segment {} transcription {}: {}",
                        segment.index,
                        response.status,
                        response.error.as_deref().unwrap_or("no detail provided")
                    );
                    return None;
                }
                other => {
                    log::warn!(
                        "voice note realtime segment {} returned unknown transcription status: {}",
                        segment.index,
                        other
                    );
                    return None;
                }
            },
            SidecarEnvelope {
                state: SidecarEnvelopeState::Initialising,
                ..
            }
            | SidecarEnvelope {
                state: SidecarEnvelopeState::Unavailable,
                ..
            } => {
                if started_at.elapsed() >= REALTIME_TRANSCRIPTION_READY_TIMEOUT {
                    log::warn!(
                        "voice note realtime segment {} could not reach the search sidecar",
                        segment.index
                    );
                    return None;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: None,
                error,
            } => {
                log::warn!(
                    "voice note realtime segment {} returned no response body: {}",
                    segment.index,
                    error.as_deref().unwrap_or("no detail provided")
                );
                return None;
            }
        }
        tokio::time::sleep(REALTIME_TRANSCRIPTION_RETRY_INTERVAL).await;
    }
}

fn append_realtime_voice_note_transcript(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    note_id: &str,
    segment: &CompletedAudioSegment,
    response: VoiceNoteTranscriptionResponseDto,
) {
    let Some(transcript) = response.transcript else {
        log::warn!(
            "voice note realtime segment {} completed without transcript text",
            segment.index
        );
        return;
    };
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note realtime transcription could not open database: {error}");
            return;
        }
    };
    let input = AppendRealtimeTranscriptInput {
        note_id: note_id.to_string(),
        transcript,
        start_ms: segment.start_ms,
        duration_ms: segment.duration_ms,
        speaker_labels: response.speaker_labels,
    };
    if let Err(error) =
        append_voice_note_realtime_transcript_record(&conn, &input, notes_dir, emitter.as_ref())
    {
        log::warn!(
            "voice note realtime transcript append failed for {} segment {}: {}",
            note_id,
            segment.index,
            error
        );
    }
}

async fn run_voice_note_transcription_job(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    note_id: String,
    audio_path: String,
) {
    let started_at = Instant::now();
    loop {
        let request = VoiceNoteTranscriptionRequestDto {
            note_id: note_id.clone(),
            audio_path: audio_path.clone(),
            language: None,
        };
        match search_client.transcribe_voice_note(&request).await {
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: Some(response),
                ..
            } => match response.status.as_str() {
                "completed" => {
                    complete_background_transcription(
                        &db, &notes_dir, &emitter, &note_id, response,
                    );
                    return;
                }
                "pending" => {
                    if started_at.elapsed() >= TRANSCRIPTION_READY_TIMEOUT {
                        fail_background_transcription(
                            &db,
                            &notes_dir,
                            &emitter,
                            &note_id,
                            "failed",
                            response
                                .error
                                .as_deref()
                                .unwrap_or("timed out waiting for Qwen ASR to become ready"),
                        );
                        return;
                    }
                }
                "unavailable" => {
                    fail_background_transcription(
                        &db,
                        &notes_dir,
                        &emitter,
                        &note_id,
                        "unavailable",
                        response
                            .error
                            .as_deref()
                            .unwrap_or("Qwen ASR runtime is unavailable"),
                    );
                    return;
                }
                "failed" => {
                    fail_background_transcription(
                        &db,
                        &notes_dir,
                        &emitter,
                        &note_id,
                        "failed",
                        response
                            .error
                            .as_deref()
                            .unwrap_or("Qwen ASR transcription failed"),
                    );
                    return;
                }
                other => {
                    fail_background_transcription(
                        &db,
                        &notes_dir,
                        &emitter,
                        &note_id,
                        "failed",
                        &format!("Qwen ASR returned unknown status: {other}"),
                    );
                    return;
                }
            },
            SidecarEnvelope {
                state: SidecarEnvelopeState::Initialising,
                ..
            } => {
                if started_at.elapsed() >= TRANSCRIPTION_READY_TIMEOUT {
                    fail_background_transcription(
                        &db,
                        &notes_dir,
                        &emitter,
                        &note_id,
                        "failed",
                        "timed out waiting for the search sidecar to start",
                    );
                    return;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Unavailable,
                error,
                ..
            } => {
                if started_at.elapsed() >= TRANSCRIPTION_READY_TIMEOUT {
                    fail_background_transcription(
                        &db,
                        &notes_dir,
                        &emitter,
                        &note_id,
                        "unavailable",
                        error.as_deref().unwrap_or("search sidecar is unavailable"),
                    );
                    return;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: None,
                error,
            } => {
                fail_background_transcription(
                    &db,
                    &notes_dir,
                    &emitter,
                    &note_id,
                    "failed",
                    error
                        .as_deref()
                        .unwrap_or("Qwen ASR returned no response body"),
                );
                return;
            }
        }
        tokio::time::sleep(TRANSCRIPTION_RETRY_INTERVAL).await;
    }
}

fn complete_background_transcription(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    note_id: &str,
    response: VoiceNoteTranscriptionResponseDto,
) {
    let Some(transcript) = response.transcript else {
        fail_background_transcription(
            db,
            notes_dir,
            emitter,
            note_id,
            "failed",
            "Qwen ASR completed without transcript text",
        );
        return;
    };
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note transcription could not open database: {error}");
            return;
        }
    };
    let input = CompleteVoiceNoteTranscriptInput {
        note_id: note_id.to_string(),
        transcript,
        summary: None,
        action_items: Vec::new(),
        speaker_labels: response.speaker_labels,
    };
    if let Err(error) =
        complete_voice_note_transcript_record(&conn, &input, notes_dir, emitter.as_ref())
    {
        log::warn!("voice note transcription completion failed for {note_id}: {error}");
    }
}

fn fail_background_transcription(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    note_id: &str,
    transcription_status: &str,
    message: &str,
) {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note transcription could not open database: {error}");
            return;
        }
    };
    if let Err(error) = mark_voice_note_transcription_failed_record(
        &conn,
        note_id,
        transcription_status,
        message,
        notes_dir,
        emitter.as_ref(),
    ) {
        log::warn!("voice note transcription failure update failed for {note_id}: {error}");
    }
}
