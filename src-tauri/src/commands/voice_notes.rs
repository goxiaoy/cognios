use tauri::State;

use crate::domain::voice_note::VoiceNoteDto;
use crate::services::voice_notes::{
    append_voice_note_audio_chunk as append_voice_note_audio_chunk_record,
    begin_voice_note_audio_capture as begin_voice_note_audio_capture_record, capture_capability,
    complete_voice_note_transcript as complete_voice_note_transcript_record,
    create_voice_note as create_voice_note_record,
    delete_voice_note_source_audio as delete_voice_note_source_audio_record,
    finish_voice_note_audio_capture as finish_voice_note_audio_capture_record,
    get_voice_note as get_voice_note_record, list_voice_notes as list_voice_notes_record,
    rename_voice_note_speaker as rename_voice_note_speaker_record, AppendVoiceNoteAudioChunkInput,
    BeginVoiceNoteAudioCaptureInput, CaptureCapabilityDto, CompleteVoiceNoteTranscriptInput,
    CreateVoiceNoteInput, CreatedVoiceNote, FinishVoiceNoteAudioCaptureInput,
    RenameVoiceNoteSpeakerInput, VoiceNoteInput,
};
use crate::AppState;

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
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    finish_voice_note_audio_capture_record(&conn, &input, &notes_dir, &emitter)
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
