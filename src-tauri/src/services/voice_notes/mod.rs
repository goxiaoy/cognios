use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::domain::voice_note::VoiceNoteDto;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::notes::create_note::{
    create_note_with_body_without_event, CreateNoteInput, CreatedNote,
};
use crate::services::notes::get_note_content::get_note_content;
use crate::services::notes::save_note_content::{emit_note_saved, write_note_content};

const SOURCE_START: &str = "<!-- voice-note:source:start -->";
const SOURCE_END: &str = "<!-- voice-note:source:end -->";
const TRANSCRIPT_START: &str = "<!-- voice-note:transcript:start -->";
const TRANSCRIPT_END: &str = "<!-- voice-note:transcript:end -->";
const SUMMARY_START: &str = "<!-- voice-note:summary:start -->";
const SUMMARY_END: &str = "<!-- voice-note:summary:end -->";
const ACTION_ITEMS_START: &str = "<!-- voice-note:action-items:start -->";
const ACTION_ITEMS_END: &str = "<!-- voice-note:action-items:end -->";

const DEFAULT_VOICE_NOTE_BODY: &str = "# Untitled Voice Note\n\n## Source Audio\n\n<!-- voice-note:source:start -->\nRecording has not started yet.\n<!-- voice-note:source:end -->\n\n## Transcript\n\n<!-- voice-note:transcript:start -->\nTranscription pending.\n<!-- voice-note:transcript:end -->\n\n## Summary\n\n<!-- voice-note:summary:start -->\nSummary unavailable until transcript is complete.\n<!-- voice-note:summary:end -->\n\n## Action Items\n\n<!-- voice-note:action-items:start -->\nNo action items yet.\n<!-- voice-note:action-items:end -->\n";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilityDto {
    pub system_audio_recording: bool,
    pub automatic_detection: bool,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVoiceNoteInput {
    pub parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedVoiceNote {
    pub voice_note: VoiceNoteDto,
    pub snapshot: ExplorerSnapshotDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginVoiceNoteAudioCaptureInput {
    pub note_id: String,
    pub mime_type: Option<String>,
    pub file_extension: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendVoiceNoteAudioChunkInput {
    pub note_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishVoiceNoteAudioCaptureInput {
    pub note_id: String,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteVoiceNoteTranscriptInput {
    pub note_id: String,
    pub transcript: String,
    pub summary: Option<String>,
    #[serde(default)]
    pub action_items: Vec<String>,
    #[serde(default)]
    pub speaker_labels: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameVoiceNoteSpeakerInput {
    pub note_id: String,
    pub speaker_id: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceNoteInput {
    pub note_id: String,
}

pub fn capture_capability() -> CaptureCapabilityDto {
    CaptureCapabilityDto {
        system_audio_recording: false,
        automatic_detection: false,
        reason: "System audio capture and meeting detection are not wired in this build."
            .to_string(),
    }
}

pub fn create_voice_note(
    conn: &mut Connection,
    input: &CreateVoiceNoteInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedVoiceNote, String> {
    let CreatedNote { node_id, snapshot } = create_note_with_body_without_event(
        conn,
        &CreateNoteInput {
            parent_id: input.parent_id.clone(),
        },
        notes_dir,
        DEFAULT_VOICE_NOTE_BODY,
    )?;

    if let Err(error) = conn.execute(
        "
        INSERT INTO voice_notes (
          note_id,
          status,
          capture_status,
          transcription_status,
          summary_status
        )
        VALUES (?1, 'pending_audio', 'unsupported', 'pending', 'unavailable')
        ",
        [&node_id],
    ) {
        let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&node_id]);
        let _ = std::fs::remove_file(notes_dir.join(format!("{node_id}.md")));
        return Err(error.to_string());
    }

    let voice_note = get_voice_note(conn, &node_id)?
        .ok_or_else(|| "voice note metadata was not created".to_string())?;

    emitter(VfsChangeEvent {
        mount_id: node_id,
        reason: "node-created".to_string(),
        ..Default::default()
    });

    Ok(CreatedVoiceNote {
        voice_note,
        snapshot,
    })
}

pub fn list_voice_notes(conn: &Connection) -> Result<Vec<VoiceNoteDto>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
              note_id,
              status,
              capture_status,
              transcription_status,
              summary_status,
              source_audio_path,
              source_audio_deleted_at,
              transcript_updated_at,
              speaker_labels_json,
              created_at,
              updated_at
            FROM voice_notes
            ORDER BY updated_at DESC, created_at DESC
            ",
        )
        .map_err(|error| error.to_string())?;

    let rows = stmt
        .query_map([], VoiceNoteDto::from_row)
        .map_err(|error| error.to_string())?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn get_voice_note(conn: &Connection, note_id: &str) -> Result<Option<VoiceNoteDto>, String> {
    conn.query_row(
        "
        SELECT
          note_id,
          status,
          capture_status,
          transcription_status,
          summary_status,
          source_audio_path,
          source_audio_deleted_at,
          transcript_updated_at,
          speaker_labels_json,
          created_at,
          updated_at
        FROM voice_notes
        WHERE note_id = ?1
        ",
        [note_id],
        VoiceNoteDto::from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn complete_voice_note_transcript(
    conn: &Connection,
    input: &CompleteVoiceNoteTranscriptInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let current =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if current.transcription_status == "completed" {
        return Err("voice note transcript is already completed".to_string());
    }

    let transcript = input.transcript.trim();
    if transcript.is_empty() {
        return Err("voice note transcript cannot be blank".to_string());
    }

    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = render_completed_transcript(&existing_body, input);
    write_note_content(conn, &input.note_id, &body, notes_dir)?;

    let speaker_labels_json =
        serde_json::to_string(&input.speaker_labels).map_err(|error| error.to_string())?;
    let summary_status = if input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .is_some()
    {
        "ready"
    } else {
        "unavailable"
    };

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'completed',
          transcription_status = 'completed',
          summary_status = ?2,
          transcript_updated_at = CURRENT_TIMESTAMP,
          speaker_labels_json = ?3,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        params![input.note_id, summary_status, speaker_labels_json],
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after transcript update".to_string())
}

pub fn begin_voice_note_audio_capture(
    conn: &Connection,
    input: &BeginVoiceNoteAudioCaptureInput,
    storage_dir: &Path,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;

    let audio_dir = voice_note_audio_dir(storage_dir, &input.note_id)?;
    fs::create_dir_all(&audio_dir).map_err(|error| error.to_string())?;
    let extension =
        audio_file_extension(input.file_extension.as_deref(), input.mime_type.as_deref());
    let audio_path = audio_dir.join(format!("source.{extension}"));
    fs::File::create(&audio_path).map_err(|error| error.to_string())?;

    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = replace_section(
        &existing_body,
        SOURCE_START,
        SOURCE_END,
        "Recording in progress. Source audio is being written locally.",
    );
    write_note_content(conn, &input.note_id, &body, notes_dir)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'recording',
          capture_status = 'recording',
          transcription_status = 'pending',
          source_audio_path = ?2,
          source_audio_deleted_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        params![input.note_id, audio_path.to_string_lossy().to_string()],
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after audio capture start".to_string())
}

pub fn append_voice_note_audio_chunk(
    conn: &Connection,
    input: &AppendVoiceNoteAudioChunkInput,
) -> Result<(), String> {
    if input.bytes.is_empty() {
        return Ok(());
    }
    let audio_path = source_audio_path_for_recording(conn, &input.note_id)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&audio_path)
        .map_err(|error| error.to_string())?;
    file.write_all(&input.bytes)
        .map_err(|error| error.to_string())
}

pub fn finish_voice_note_audio_capture(
    conn: &Connection,
    input: &FinishVoiceNoteAudioCaptureInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.capture_status != "recording" {
        return Err("voice note is not currently recording".to_string());
    }
    let audio_path = voice_note
        .source_audio_path
        .as_deref()
        .ok_or_else(|| "voice note source audio path is missing".to_string())?;
    let audio_path = PathBuf::from(audio_path);
    let metadata = fs::metadata(&audio_path).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        mark_voice_note_capture_failed(conn, &input.note_id)?;
        return Err("voice note source audio is empty".to_string());
    }

    let file_name = audio_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source audio");
    let duration = input
        .duration_ms
        .map(format_duration)
        .unwrap_or_else(|| "duration unknown".to_string());
    let source_text =
        format!("Source audio saved locally as `{file_name}` ({duration}). Transcription pending.");
    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = replace_section(&existing_body, SOURCE_START, SOURCE_END, &source_text);
    write_note_content(conn, &input.note_id, &body, notes_dir)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'transcribing',
          capture_status = 'completed',
          transcription_status = 'pending',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [&input.note_id],
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after audio capture finish".to_string())
}

pub fn rename_voice_note_speaker(
    conn: &Connection,
    input: &RenameVoiceNoteSpeakerInput,
) -> Result<VoiceNoteDto, String> {
    let mut voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    voice_note
        .speaker_labels
        .insert(input.speaker_id.clone(), input.label.trim().to_string());

    let speaker_labels_json =
        serde_json::to_string(&voice_note.speaker_labels).map_err(|error| error.to_string())?;
    conn.execute(
        "
        UPDATE voice_notes
        SET speaker_labels_json = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        params![input.note_id, speaker_labels_json],
    )
    .map_err(|error| error.to_string())?;

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after speaker rename".to_string())
}

pub fn delete_voice_note_source_audio(
    conn: &Connection,
    input: &VoiceNoteInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;

    let source_audio_path = voice_note.source_audio_path.clone();

    if let Some(path) = source_audio_path.as_deref() {
        let path = Path::new(path);
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }

    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = replace_section(
        &existing_body,
        SOURCE_START,
        SOURCE_END,
        "Source audio has been deleted.",
    );
    write_note_content(conn, &input.note_id, &body, notes_dir)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          source_audio_path = NULL,
          source_audio_deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [&input.note_id],
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after source audio deletion".to_string())
}

fn render_completed_transcript(
    existing_body: &str,
    input: &CompleteVoiceNoteTranscriptInput,
) -> String {
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .unwrap_or("Summary unavailable.");

    let action_items = if input.action_items.is_empty() {
        "No action items yet.".to_string()
    } else {
        input
            .action_items
            .iter()
            .map(|item| format!("- {}", item.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let with_source = replace_section(
        existing_body,
        SOURCE_START,
        SOURCE_END,
        "Source audio retained with the voice note when recording is available.",
    );
    let with_transcript = replace_section(
        &with_source,
        TRANSCRIPT_START,
        TRANSCRIPT_END,
        input.transcript.trim(),
    );
    let with_summary = replace_section(&with_transcript, SUMMARY_START, SUMMARY_END, summary);
    replace_section(
        &with_summary,
        ACTION_ITEMS_START,
        ACTION_ITEMS_END,
        &action_items,
    )
}

fn replace_section(existing: &str, start: &str, end: &str, replacement: &str) -> String {
    let Some(start_index) = existing.find(start) else {
        return append_section(existing, start, end, replacement);
    };
    let content_start = start_index + start.len();
    let Some(relative_end_index) = existing[content_start..].find(end) else {
        return append_section(existing, start, end, replacement);
    };
    let end_index = content_start + relative_end_index;

    format!(
        "{}\n{}\n{}",
        &existing[..content_start],
        replacement,
        &existing[end_index..]
    )
}

fn append_section(existing: &str, start: &str, end: &str, replacement: &str) -> String {
    let separator = if existing.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    format!("{existing}{separator}{start}\n{replacement}\n{end}\n")
}

fn voice_note_audio_dir(storage_dir: &Path, note_id: &str) -> Result<PathBuf, String> {
    if !note_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("invalid voice note id for audio path".to_string());
    }
    Ok(storage_dir.join("voice-notes").join(note_id))
}

fn audio_file_extension(file_extension: Option<&str>, mime_type: Option<&str>) -> String {
    if let Some(extension) = file_extension.and_then(sanitize_extension) {
        return extension;
    }
    match mime_type.unwrap_or("").split(';').next().unwrap_or("") {
        "audio/mp4" | "audio/aac" => "m4a",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        _ => "webm",
    }
    .to_string()
}

fn sanitize_extension(raw: &str) -> Option<String> {
    let extension = raw.trim().trim_start_matches('.');
    if extension.is_empty() || extension.len() > 12 {
        return None;
    }
    if !extension
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return None;
    }
    Some(extension.to_ascii_lowercase())
}

fn source_audio_path_for_recording(conn: &Connection, note_id: &str) -> Result<PathBuf, String> {
    let path = conn
        .query_row(
            "
            SELECT source_audio_path
            FROM voice_notes
            WHERE note_id = ?1 AND capture_status = 'recording'
            ",
            [note_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .ok_or_else(|| "voice note is not currently recording".to_string())?;
    Ok(PathBuf::from(path))
}

fn mark_voice_note_capture_failed(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'failed',
          capture_status = 'failed',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [note_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn format_duration(duration_ms: u64) -> String {
    let total_seconds = (duration_ms + 500) / 1000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    if minutes == 0 {
        format!("{seconds}s")
    } else {
        format!("{minutes}m {seconds:02}s")
    }
}
