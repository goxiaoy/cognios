use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::State;

use crate::commands::realtime_voice::RealtimeVoiceEventPayload;
use crate::domain::voice_note::VoiceNoteDto;
use crate::infrastructure::db::connection::Database;
use crate::services::realtime_voice::vllm::{
    run_vllm_audio_file_transcription, run_vllm_realtime_transcription,
    VllmRealtimeTranscriptEvent, VllmRealtimeTranscriptSegment,
};
use crate::services::search::{
    SearchSidecarClient, SidecarEnvelope, SidecarEnvelopeState, VoiceNoteSummaryRequestDto,
    VoiceNoteSummaryResponseDto,
};
use crate::services::voice_notes::native_audio::NativeAudioCapture;
use crate::services::voice_notes::{
    append_voice_note_audio_chunk as append_voice_note_audio_chunk_record,
    append_voice_note_realtime_transcript as append_voice_note_realtime_transcript_record,
    begin_voice_note_audio_capture as begin_voice_note_audio_capture_record,
    begin_voice_note_retranscription as begin_voice_note_retranscription_record,
    begin_voice_note_summary as begin_voice_note_summary_record, capture_capability,
    claim_next_voice_note_summary_job as claim_next_voice_note_summary_job_record,
    complete_voice_note_summary as complete_voice_note_summary_record,
    complete_voice_note_summary_job as complete_voice_note_summary_job_record,
    complete_voice_note_transcript as complete_voice_note_transcript_record,
    create_voice_note as create_voice_note_record,
    delete_voice_note_source_audio as delete_voice_note_source_audio_record,
    enqueue_voice_note_summary_job as enqueue_voice_note_summary_job_record,
    fail_voice_note_summary_job as fail_voice_note_summary_job_record,
    finish_voice_note_audio_capture as finish_voice_note_audio_capture_record,
    get_voice_note as get_voice_note_record,
    get_voice_note_transcript as get_voice_note_transcript_record,
    has_queued_voice_note_summary_jobs as has_queued_voice_note_summary_jobs_record,
    list_voice_notes as list_voice_notes_record,
    mark_voice_note_capture_failed as mark_voice_note_capture_failed_record,
    mark_voice_note_summary_failed as mark_voice_note_summary_failed_record,
    mark_voice_note_transcription_failed as mark_voice_note_transcription_failed_record,
    recover_interrupted_voice_note_processing as recover_interrupted_voice_note_processing_record,
    recover_voice_note_summary_jobs as recover_voice_note_summary_jobs_record,
    rename_voice_note_speaker as rename_voice_note_speaker_record,
    voice_note_summary_job_is_running as voice_note_summary_job_is_running_record,
    AppendRealtimeTranscriptInput, AppendVoiceNoteAudioChunkInput, BeginVoiceNoteAudioCaptureInput,
    CaptureCapabilityDto, CompleteVoiceNoteSummaryInput, CompleteVoiceNoteTranscriptInput,
    CreateVoiceNoteInput, CreatedVoiceNote, FinishVoiceNoteAudioCaptureInput,
    RenameVoiceNoteSpeakerInput, VoiceNoteInput, VoiceNoteSummaryJob, VoiceNoteSummaryJobFailure,
};
use crate::{AppState, RealtimeVoiceEventEmitter, VfsEventEmitter};

const TRANSCRIPTION_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const TRANSCRIPTION_READY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SUMMARY_RETRY_INTERVAL: Duration = Duration::from_secs(5);
const SUMMARY_READY_TIMEOUT: Duration = Duration::from_secs(4 * 60);
const REALTIME_TRANSCRIPTION_SEGMENT_POLL_INTERVAL: Duration = Duration::from_millis(200);
static VOICE_NOTE_SUMMARY_DRAIN_RUNNING: AtomicBool = AtomicBool::new(false);

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
    let mut updated = complete_voice_note_transcript_record(&conn, &input, &notes_dir, &emitter)?;
    if input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .is_none()
    {
        updated = enqueue_voice_note_summary_job_record(&conn, &input.note_id, emitter)?;
        spawn_voice_note_summary_queue_drain(
            state.db.clone(),
            notes_dir,
            Arc::clone(&state.emitter),
            Arc::clone(&state.search_client),
        );
    }
    Ok(updated)
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendRealtimeVoiceNoteTranscriptCommandInput {
    pub note_id: String,
    pub transcript: String,
    #[serde(default)]
    pub start_ms: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub fn append_realtime_voice_note_transcript(
    state: State<'_, AppState>,
    input: AppendRealtimeVoiceNoteTranscriptCommandInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let append_input = AppendRealtimeTranscriptInput {
        note_id: input.note_id,
        transcript: input.transcript,
        start_ms: input.start_ms.unwrap_or_default(),
        duration_ms: input.duration_ms.unwrap_or_default(),
        speaker_labels: Default::default(),
    };
    append_voice_note_realtime_transcript_record(&conn, &append_input, &notes_dir, emitter)
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
    spawn_realtime_voice_note_transcription(
        state.db.clone(),
        notes_dir,
        Arc::clone(&state.emitter),
        Arc::clone(&state.realtime_voice_emitter),
        Arc::clone(&state.search_client),
        Arc::clone(&state.voice_note_audio_capture),
        voice_note.note_id.clone(),
        audio_path.to_string(),
    );
    Ok(voice_note)
}

#[tauri::command]
pub fn finish_native_voice_note_audio_capture(
    state: State<'_, AppState>,
    input: FinishVoiceNoteAudioCaptureInput,
) -> Result<VoiceNoteDto, String> {
    let elapsed_ms = state.voice_note_audio_capture.stop(&input.note_id)?;
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    finish_voice_note_audio_capture_record(
        &conn,
        &FinishVoiceNoteAudioCaptureInput {
            note_id: input.note_id,
            duration_ms: Some(elapsed_ms),
        },
        &notes_dir,
        &emitter,
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

#[tauri::command]
pub fn retranscribe_voice_note(
    state: State<'_, AppState>,
    input: VoiceNoteInput,
) -> Result<VoiceNoteDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let emitter = state.emitter.as_ref();
    let voice_note = begin_voice_note_retranscription_record(&conn, &input, &emitter)?;
    let audio_path = voice_note
        .source_audio_path
        .clone()
        .ok_or_else(|| "voice note source audio path is missing".to_string())?;
    spawn_voice_note_transcription(
        state.db.clone(),
        state.storage_dir.join("notes"),
        Arc::clone(&state.emitter),
        Arc::clone(&state.search_client),
        voice_note.note_id.clone(),
        audio_path,
    );
    Ok(voice_note)
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
    realtime_voice_emitter: RealtimeVoiceEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    audio_capture: Arc<NativeAudioCapture>,
    note_id: String,
    audio_path: String,
) {
    tauri::async_runtime::spawn(async move {
        run_realtime_voice_note_transcription_job(
            db,
            notes_dir,
            emitter,
            realtime_voice_emitter,
            search_client,
            audio_capture,
            note_id,
            audio_path,
        )
        .await;
    });
}

async fn run_realtime_voice_note_transcription_job(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    realtime_voice_emitter: RealtimeVoiceEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    audio_capture: Arc<NativeAudioCapture>,
    note_id: String,
    audio_path: String,
) {
    if let Some((websocket_url, model)) = realtime_voice_websocket_config(&search_client).await {
        match run_vllm_realtime_voice_note_transcription_job(
            &db,
            &notes_dir,
            &emitter,
            &realtime_voice_emitter,
            Arc::clone(&search_client),
            &audio_capture,
            &note_id,
            websocket_url,
            model,
        )
        .await
        {
            Ok(()) => return,
            Err(error) => {
                log::warn!(
                    "vLLM realtime voice note transcription failed for {note_id}; retrying from saved audio: {error}"
                );
            }
        }
    }

    while audio_capture.is_recording_active(&note_id) {
        tokio::time::sleep(REALTIME_TRANSCRIPTION_SEGMENT_POLL_INTERVAL).await;
    }
    run_voice_note_transcription_job(db, notes_dir, emitter, search_client, note_id, audio_path)
        .await;
}

async fn realtime_voice_websocket_config(
    search_client: &SearchSidecarClient,
) -> Option<(String, Option<String>)> {
    match search_client.realtime_voice_status().await {
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: Some(status),
            ..
        } if status.available && status.status == "ready" => status
            .websocket_url
            .map(|websocket_url| (websocket_url, status.model)),
        _ => None,
    }
}

async fn wait_for_realtime_voice_websocket_config(
    search_client: &SearchSidecarClient,
    timeout: Duration,
) -> Option<(String, Option<String>)> {
    let started_at = Instant::now();
    loop {
        if let Some(config) = realtime_voice_websocket_config(search_client).await {
            return Some(config);
        }
        if started_at.elapsed() >= timeout {
            return None;
        }
        tokio::time::sleep(TRANSCRIPTION_RETRY_INTERVAL).await;
    }
}

async fn run_vllm_realtime_voice_note_transcription_job(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    realtime_voice_emitter: &RealtimeVoiceEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    audio_capture: &NativeAudioCapture,
    note_id: &str,
    websocket_url: String,
    model: Option<String>,
) -> Result<(), String> {
    let audio_rx = audio_capture.subscribe_realtime_audio(note_id)?;
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(32);
    let realtime_task = tauri::async_runtime::spawn(run_vllm_realtime_transcription(
        websocket_url,
        model,
        audio_rx,
        event_tx,
    ));
    let started_at = Instant::now();
    let mut sequence = 0;
    let mut fallback_utterance_index = 1;
    let mut active_fallback_utterance_id: Option<String> = None;
    let mut active_fallback_start_ms: Option<u64> = None;

    while let Some(event) = event_rx.recv().await {
        sequence += 1;
        match event {
            VllmRealtimeTranscriptEvent::Provisional(segment) => {
                let fallback_start_ms = *active_fallback_start_ms
                    .get_or_insert_with(|| started_at.elapsed().as_millis() as u64);
                let utterance_id = segment.utterance_id.clone().unwrap_or_else(|| {
                    active_fallback_utterance_id
                        .get_or_insert_with(|| {
                            let id = format!("{note_id}:realtime:{fallback_utterance_index}");
                            fallback_utterance_index += 1;
                            id
                        })
                        .clone()
                });
                realtime_voice_emitter(RealtimeVoiceEventPayload::provisional_caption(
                    note_id.to_string(),
                    utterance_id,
                    segment.text,
                    sequence,
                    segment.revision.unwrap_or(sequence),
                    segment.start_ms.unwrap_or(fallback_start_ms),
                    segment.end_ms,
                ));
            }
            VllmRealtimeTranscriptEvent::Final(segment) => {
                let fallback_start_ms = active_fallback_start_ms
                    .take()
                    .unwrap_or_else(|| started_at.elapsed().as_millis() as u64);
                let utterance_id = segment.utterance_id.clone().unwrap_or_else(|| {
                    active_fallback_utterance_id.take().unwrap_or_else(|| {
                        let id = format!("{note_id}:realtime:{fallback_utterance_index}");
                        fallback_utterance_index += 1;
                        id
                    })
                });
                active_fallback_utterance_id = None;
                append_vllm_realtime_voice_note_transcript(
                    db,
                    notes_dir,
                    emitter,
                    realtime_voice_emitter,
                    note_id,
                    &utterance_id,
                    segment.start_ms.unwrap_or(fallback_start_ms),
                    segment.end_ms,
                    sequence,
                    segment.revision.unwrap_or(sequence),
                    segment.text,
                )?;
            }
            VllmRealtimeTranscriptEvent::Error(message) => return Err(message),
        }
    }

    match realtime_task.await {
        Ok(Ok(())) => {
            complete_realtime_voice_note_transcription(
                db,
                notes_dir,
                emitter,
                &search_client,
                note_id,
            );
            Ok(())
        }
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!("vLLM realtime voice task failed: {error}")),
    }
}

fn append_vllm_realtime_voice_note_transcript(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    realtime_voice_emitter: &RealtimeVoiceEventEmitter,
    note_id: &str,
    utterance_id: &str,
    start_ms: u64,
    end_ms: Option<u64>,
    sequence: u64,
    revision: u64,
    transcript: String,
) -> Result<(), String> {
    let conn = db.connect().map_err(|error| {
        format!("voice note realtime transcription could not open database: {error}")
    })?;
    let input = AppendRealtimeTranscriptInput {
        note_id: note_id.to_string(),
        transcript: transcript.clone(),
        start_ms,
        duration_ms: end_ms
            .map(|end_ms| end_ms.saturating_sub(start_ms))
            .unwrap_or(0),
        speaker_labels: Default::default(),
    };
    append_voice_note_realtime_transcript_record(&conn, &input, notes_dir, emitter.as_ref())?;
    realtime_voice_emitter(RealtimeVoiceEventPayload::final_utterance(
        note_id.to_string(),
        utterance_id.to_string(),
        transcript,
        sequence,
        revision,
        start_ms,
        end_ms,
        true,
    ));
    Ok(())
}

fn complete_realtime_voice_note_transcription(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    search_client: &Arc<SearchSidecarClient>,
    note_id: &str,
) {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note realtime transcription could not open database: {error}");
            return;
        }
    };
    let transcript = match get_voice_note_transcript_record(&conn, note_id, notes_dir) {
        Ok(transcript) => transcript,
        Err(error) => {
            log::warn!("voice note realtime transcription could not read transcript: {error}");
            return;
        }
    };
    let transcript = transcript.trim();
    if is_unfinished_realtime_transcript(transcript) {
        if let Err(error) = mark_voice_note_transcription_failed_record(
            &conn,
            note_id,
            "unavailable",
            "No realtime transcript was captured",
            notes_dir,
            emitter.as_ref(),
        ) {
            log::warn!("voice note realtime transcription unavailable update failed: {error}");
        }
        return;
    }
    let speaker_labels = match get_voice_note_record(&conn, note_id) {
        Ok(Some(voice_note)) => voice_note.speaker_labels,
        Ok(None) => {
            log::warn!("voice note realtime transcription missing voice note {note_id}");
            return;
        }
        Err(error) => {
            log::warn!("voice note realtime transcription could not read voice note: {error}");
            return;
        }
    };
    let input = CompleteVoiceNoteTranscriptInput {
        note_id: note_id.to_string(),
        transcript: transcript.to_string(),
        summary: None,
        action_items: Vec::new(),
        speaker_labels,
    };
    if let Err(error) =
        complete_voice_note_transcript_record(&conn, &input, notes_dir, emitter.as_ref())
    {
        log::warn!("voice note realtime transcription completion failed for {note_id}: {error}");
        return;
    }
    enqueue_voice_note_summary_job_async(
        db.clone(),
        notes_dir.to_path_buf(),
        Arc::clone(emitter),
        Arc::clone(search_client),
        note_id,
    );
}

fn is_unfinished_realtime_transcript(transcript: &str) -> bool {
    transcript.is_empty()
        || transcript == "Transcription pending."
        || transcript.starts_with("Transcription failed:")
        || transcript.starts_with("Transcription unavailable:")
}

async fn run_voice_note_transcription_job(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    note_id: String,
    audio_path: String,
) {
    if !audio_path_has_samples(Path::new(&audio_path)) {
        fail_background_transcription(
            &db,
            &notes_dir,
            &emitter,
            &note_id,
            "failed",
            "voice note audio file has no audio samples",
        );
        return;
    }
    let Some((websocket_url, model)) =
        wait_for_realtime_voice_websocket_config(&search_client, TRANSCRIPTION_READY_TIMEOUT).await
    else {
        fail_background_transcription(
            &db,
            &notes_dir,
            &emitter,
            &note_id,
            "unavailable",
            "Local realtime voice runtime is unavailable",
        );
        return;
    };

    match transcribe_saved_audio_with_vllm(websocket_url, model, &audio_path).await {
        Ok(segments) if !segments.is_empty() => {
            complete_vllm_background_transcription(
                &db,
                &notes_dir,
                &emitter,
                &search_client,
                &note_id,
                segments,
            );
        }
        Ok(_) => {
            fail_background_transcription(
                &db,
                &notes_dir,
                &emitter,
                &note_id,
                "failed",
                "vLLM ASR completed without transcript text",
            );
        }
        Err(error) => {
            fail_background_transcription(&db, &notes_dir, &emitter, &note_id, "failed", &error);
        }
    }
}

fn audio_path_has_samples(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.len() == 0 {
        return false;
    }
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
    {
        return hound::WavReader::open(path)
            .map(|reader| reader.duration() > 0)
            .unwrap_or(false);
    }
    true
}

async fn transcribe_saved_audio_with_vllm(
    websocket_url: String,
    model: Option<String>,
    audio_path: &str,
) -> Result<Vec<VllmRealtimeTranscriptSegment>, String> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(32);
    let audio_path = PathBuf::from(audio_path);
    let transcription_task = tauri::async_runtime::spawn(async move {
        run_vllm_audio_file_transcription(websocket_url, model, &audio_path, event_tx).await
    });
    let mut segments = Vec::new();

    while let Some(event) = event_rx.recv().await {
        match event {
            VllmRealtimeTranscriptEvent::Final(segment) => segments.push(segment),
            VllmRealtimeTranscriptEvent::Provisional(_) => {}
            VllmRealtimeTranscriptEvent::Error(message) => return Err(message),
        }
    }

    match transcription_task.await {
        Ok(Ok(())) => Ok(segments),
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!(
            "vLLM saved-audio transcription task failed: {error}"
        )),
    }
}

fn complete_vllm_background_transcription(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    search_client: &Arc<SearchSidecarClient>,
    note_id: &str,
    segments: Vec<VllmRealtimeTranscriptSegment>,
) {
    let transcript = vllm_segments_to_transcript(&segments);
    if transcript.trim().is_empty() {
        fail_background_transcription(
            db,
            notes_dir,
            emitter,
            note_id,
            "failed",
            "vLLM ASR completed without transcript text",
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
        speaker_labels: Default::default(),
    };
    if let Err(error) =
        complete_voice_note_transcript_record(&conn, &input, notes_dir, emitter.as_ref())
    {
        log::warn!("voice note transcription completion failed for {note_id}: {error}");
        return;
    }
    enqueue_voice_note_summary_job_async(
        db.clone(),
        notes_dir.to_path_buf(),
        Arc::clone(emitter),
        Arc::clone(search_client),
        note_id,
    );
}

fn vllm_segments_to_transcript(segments: &[VllmRealtimeTranscriptSegment]) -> String {
    segments
        .iter()
        .filter_map(|segment| {
            let text = segment.text.trim();
            if text.is_empty() {
                return None;
            }
            match (segment.start_ms, segment.end_ms) {
                (Some(start_ms), Some(end_ms)) if end_ms > start_ms => Some(format!(
                    "[{} - {}] {}",
                    format_transcript_timestamp(start_ms),
                    format_transcript_timestamp(end_ms),
                    text
                )),
                (Some(start_ms), _) => Some(format!(
                    "[{}] {}",
                    format_transcript_timestamp(start_ms),
                    text
                )),
                _ => Some(text.to_string()),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_transcript_timestamp(duration_ms: u64) -> String {
    let minutes = duration_ms / 60_000;
    let seconds = (duration_ms % 60_000) / 1_000;
    let millis = duration_ms % 1_000;
    format!("{minutes:02}:{seconds:02}.{millis:03}")
}

fn enqueue_voice_note_summary_job_async(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    note_id: &str,
) {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note summary enqueue could not open database: {error}");
            return;
        }
    };
    if let Err(error) = enqueue_voice_note_summary_job_record(&conn, note_id, emitter.as_ref()) {
        log::warn!("voice note summary enqueue failed for {note_id}: {error}");
        return;
    }
    spawn_voice_note_summary_queue_drain(db, notes_dir, emitter, search_client);
}

pub fn resume_voice_note_summary_jobs(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
) -> Result<(), String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    let recovered = recover_voice_note_summary_jobs_record(&conn, emitter.as_ref())?;
    if recovered > 0 {
        log::info!("recovered {recovered} pending voice note summary job(s)");
    }
    drop(conn);
    spawn_voice_note_summary_queue_drain(db, notes_dir, emitter, search_client);
    Ok(())
}

pub fn resume_voice_note_processing_jobs(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
) -> Result<(), String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    let recovery =
        recover_interrupted_voice_note_processing_record(&conn, &notes_dir, emitter.as_ref())?;
    if recovery.interrupted_recordings > 0 {
        log::info!(
            "recovered {} interrupted voice note recording(s)",
            recovery.interrupted_recordings
        );
    }
    if recovery.failed_transcriptions > 0 {
        log::info!(
            "marked {} interrupted voice note transcription job(s) failed",
            recovery.failed_transcriptions
        );
    }
    let transcription_jobs = recovery.transcription_jobs;
    drop(conn);

    if !transcription_jobs.is_empty() {
        log::info!(
            "resuming {} pending voice note transcription job(s)",
            transcription_jobs.len()
        );
    }
    for job in transcription_jobs {
        spawn_voice_note_transcription(
            db.clone(),
            notes_dir.clone(),
            Arc::clone(&emitter),
            Arc::clone(&search_client),
            job.note_id,
            job.audio_path,
        );
    }
    Ok(())
}

fn spawn_voice_note_summary_queue_drain(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
) {
    if VOICE_NOTE_SUMMARY_DRAIN_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        run_voice_note_summary_queue_drain(
            db.clone(),
            notes_dir.clone(),
            Arc::clone(&emitter),
            Arc::clone(&search_client),
        )
        .await;
        VOICE_NOTE_SUMMARY_DRAIN_RUNNING.store(false, Ordering::SeqCst);

        let should_resume = db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| has_queued_voice_note_summary_jobs_record(&conn))
            .unwrap_or(false);
        if should_resume {
            spawn_voice_note_summary_queue_drain(db, notes_dir, emitter, search_client);
        }
    });
}

async fn run_voice_note_summary_queue_drain(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
) {
    loop {
        let job = match db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| claim_next_voice_note_summary_job_record(&conn))
        {
            Ok(Some(job)) => job,
            Ok(None) => return,
            Err(error) => {
                log::warn!("voice note summary queue claim failed: {error}");
                return;
            }
        };
        run_voice_note_summary_job(
            db.clone(),
            notes_dir.clone(),
            Arc::clone(&emitter),
            Arc::clone(&search_client),
            job,
        )
        .await;
    }
}

async fn run_voice_note_summary_job(
    db: Database,
    notes_dir: PathBuf,
    emitter: VfsEventEmitter,
    search_client: Arc<SearchSidecarClient>,
    job: VoiceNoteSummaryJob,
) {
    let note_id = job.node_id.clone();
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note summary could not open database: {error}");
            return;
        }
    };
    let transcript = match get_voice_note_transcript_record(&conn, &note_id, &notes_dir) {
        Ok(transcript) => transcript.trim().to_string(),
        Err(error) => {
            log::warn!("voice note summary could not read saved transcript for {note_id}: {error}");
            fail_claimed_voice_note_summary(&db, &emitter, &job, &error, true);
            return;
        }
    };
    if transcript.is_empty() {
        log::warn!("voice note summary skipped for {note_id}: saved transcript is empty");
        fail_claimed_voice_note_summary(&db, &emitter, &job, "saved transcript is empty", false);
        return;
    }
    if let Err(error) = begin_voice_note_summary_record(&conn, &note_id, emitter.as_ref()) {
        log::warn!("voice note summary start failed for {note_id}: {error}");
        fail_claimed_voice_note_summary(&db, &emitter, &job, &error, false);
        return;
    }
    drop(conn);

    let started_at = Instant::now();
    loop {
        let request = VoiceNoteSummaryRequestDto {
            note_id: note_id.clone(),
            transcript: transcript.clone(),
            model: None,
        };
        match search_client.summarize_voice_note(&request).await {
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: Some(response),
                ..
            } => match response.status.as_str() {
                "completed" => {
                    match complete_background_summary(&db, &notes_dir, &emitter, &job, response) {
                        Ok(()) => mark_claimed_voice_note_summary_completed(&db, &job),
                        Err(error) => {
                            fail_claimed_voice_note_summary(&db, &emitter, &job, &error, true)
                        }
                    }
                    return;
                }
                "unavailable" => {
                    fail_claimed_voice_note_summary(
                        &db,
                        &emitter,
                        &job,
                        response
                            .error
                            .as_deref()
                            .unwrap_or("LLM provider unavailable"),
                        false,
                    );
                    return;
                }
                "failed" => {
                    fail_claimed_voice_note_summary(
                        &db,
                        &emitter,
                        &job,
                        response.error.as_deref().unwrap_or("LLM summary failed"),
                        true,
                    );
                    return;
                }
                other => {
                    fail_claimed_voice_note_summary(
                        &db,
                        &emitter,
                        &job,
                        &format!("LLM summary returned unknown status: {other}"),
                        true,
                    );
                    return;
                }
            },
            SidecarEnvelope {
                state: SidecarEnvelopeState::Initialising,
                ..
            } => {
                if started_at.elapsed() >= SUMMARY_READY_TIMEOUT {
                    fail_claimed_voice_note_summary(
                        &db,
                        &emitter,
                        &job,
                        "timed out waiting for the search sidecar to start",
                        true,
                    );
                    return;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Unavailable,
                error,
                ..
            } => {
                if started_at.elapsed() >= SUMMARY_READY_TIMEOUT {
                    fail_claimed_voice_note_summary(
                        &db,
                        &emitter,
                        &job,
                        error.as_deref().unwrap_or("search sidecar is unavailable"),
                        false,
                    );
                    return;
                }
            }
            SidecarEnvelope {
                state: SidecarEnvelopeState::Ready,
                data: None,
                error,
            } => {
                fail_claimed_voice_note_summary(
                    &db,
                    &emitter,
                    &job,
                    error
                        .as_deref()
                        .unwrap_or("LLM summary returned no response body"),
                    true,
                );
                return;
            }
        }
        tokio::time::sleep(SUMMARY_RETRY_INTERVAL).await;
    }
}

fn complete_background_summary(
    db: &Database,
    notes_dir: &Path,
    emitter: &VfsEventEmitter,
    job: &VoiceNoteSummaryJob,
    response: VoiceNoteSummaryResponseDto,
) -> Result<(), String> {
    let Some(summary) = response.summary else {
        return Err("LLM summary completed without summary text".to_string());
    };
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            return Err(format!(
                "voice note summary could not open database: {error}"
            ));
        }
    };
    if !voice_note_summary_job_is_running_record(&conn, job)? {
        log::info!(
            "voice note summary result ignored for stale job {} generation {}",
            job.node_id,
            job.generation
        );
        return Ok(());
    }
    let input = CompleteVoiceNoteSummaryInput {
        note_id: job.node_id.clone(),
        summary,
        action_items: response.action_items,
    };
    complete_voice_note_summary_record(&conn, &input, notes_dir, emitter.as_ref()).map(|_| ())
}

fn mark_claimed_voice_note_summary_completed(db: &Database, job: &VoiceNoteSummaryJob) {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note summary completion could not open database: {error}");
            return;
        }
    };
    match complete_voice_note_summary_job_record(&conn, job) {
        Ok(true) => {}
        Ok(false) => log::info!(
            "voice note summary completion ignored for stale job {} generation {}",
            job.node_id,
            job.generation
        ),
        Err(error) => log::warn!("voice note summary job completion failed: {error}"),
    }
}

fn fail_claimed_voice_note_summary(
    db: &Database,
    emitter: &VfsEventEmitter,
    job: &VoiceNoteSummaryJob,
    message: &str,
    retryable: bool,
) {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("voice note summary could not open database: {error}");
            return;
        }
    };
    match fail_voice_note_summary_job_record(&conn, job, message, retryable, emitter.as_ref()) {
        Ok(VoiceNoteSummaryJobFailure::Requeued) | Ok(VoiceNoteSummaryJobFailure::Stale) => {}
        Ok(VoiceNoteSummaryJobFailure::Failed) => {
            if let Err(error) = mark_voice_note_summary_failed_record(
                &conn,
                &job.node_id,
                message,
                retryable,
                emitter.as_ref(),
            ) {
                log::warn!(
                    "voice note summary failure update failed for {}: {}",
                    job.node_id,
                    error
                );
            }
        }
        Err(error) => log::warn!("voice note summary job failure update failed: {error}"),
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
