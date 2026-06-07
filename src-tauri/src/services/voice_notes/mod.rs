use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::domain::node_status::{StageState, StageUpdate};
use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::domain::voice_note::VoiceNoteDto;
use crate::infrastructure::db::background_task_repository::{
    background_task_is_running, cancel_background_tasks, claim_next_background_task,
    complete_background_task, enqueue_background_task, fail_background_task,
    has_queued_background_tasks, recover_background_tasks, BackgroundTask, BackgroundTaskFailure,
};
use crate::infrastructure::db::node_repository::list_snapshot;
use crate::infrastructure::db::node_status_repository::{
    ensure_default_stages_for_node, update_stage,
};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::notes::create_note::{
    create_note_with_name_and_body_without_event, CreateNoteInput, CreatedNote,
};
use crate::services::notes::get_note_content::get_note_content;
use crate::services::notes::save_note_content::{emit_note_saved, write_note_content};

pub mod native_audio;

const TRANSCRIPT_START: &str = "<!-- voice-note:transcript:start -->";
const TRANSCRIPT_END: &str = "<!-- voice-note:transcript:end -->";
const SUMMARY_START: &str = "<!-- voice-note:summary:start -->";
const SUMMARY_END: &str = "<!-- voice-note:summary:end -->";
const ACTION_ITEMS_START: &str = "<!-- voice-note:action-items:start -->";
const ACTION_ITEMS_END: &str = "<!-- voice-note:action-items:end -->";
const SUMMARY_HEADING: &str = "## Summary";
const ACTION_ITEMS_HEADING: &str = "## Action Items";
const VOICE_SUMMARY_TASK_TYPE: &str = "voice.summary";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilityDto {
    pub manual_audio_recording: bool,
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

#[derive(Debug, Clone)]
pub struct CompleteVoiceNoteSummaryInput {
    pub note_id: String,
    pub summary: String,
    pub action_items: Vec<String>,
}

pub type VoiceNoteSummaryJob = BackgroundTask;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceNoteTranscriptionJob {
    pub note_id: String,
    pub audio_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceNoteProcessingRecovery {
    pub interrupted_recordings: usize,
    pub transcription_jobs: Vec<VoiceNoteTranscriptionJob>,
    pub failed_transcriptions: usize,
}

pub type VoiceNoteSummaryJobFailure = BackgroundTaskFailure;

#[derive(Debug, Clone)]
pub struct AppendRealtimeTranscriptInput {
    pub note_id: String,
    pub transcript: String,
    pub start_ms: u64,
    pub duration_ms: u64,
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
    let manual_audio_recording = native_audio::microphone_recording_available();
    let reason = if manual_audio_recording {
        "Manual microphone recording is available. Automatic meeting detection and system audio capture are not wired in this build."
    } else {
        "No default microphone input was found. Automatic meeting detection and system audio capture are not wired in this build."
    };
    CaptureCapabilityDto {
        manual_audio_recording,
        system_audio_recording: false,
        automatic_detection: false,
        reason: reason.to_string(),
    }
}

pub fn create_voice_note(
    conn: &mut Connection,
    input: &CreateVoiceNoteInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedVoiceNote, String> {
    let title = voice_note_title_for_current_time(conn)?;
    let body = default_voice_note_body(&title);
    let CreatedNote {
        node_id,
        snapshot: _,
    } = create_note_with_name_and_body_without_event(
        conn,
        &CreateNoteInput {
            parent_id: input.parent_id.clone(),
        },
        notes_dir,
        &title,
        &body,
    )?;

    let transcript_path = voice_note_transcript_path_for_notes_dir(notes_dir, &node_id)?;
    if let Some(parent) = transcript_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&node_id]);
            let _ = std::fs::remove_file(notes_dir.join(format!("{node_id}.md")));
            return Err(error.to_string());
        }
    }
    if let Err(error) = fs::write(&transcript_path, b"") {
        let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&node_id]);
        let _ = std::fs::remove_file(notes_dir.join(format!("{node_id}.md")));
        return Err(error.to_string());
    }
    let transcript_path_value = transcript_path.to_string_lossy().to_string();

    if let Err(error) = conn.execute(
        "
        INSERT INTO voice_notes (
          note_id,
          status,
          capture_status,
          transcription_status,
          summary_status,
          transcript_path
        )
        VALUES (?1, 'pending_audio', 'unsupported', 'pending', 'unavailable', ?2)
        ",
        params![&node_id, transcript_path_value],
    ) {
        let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&node_id]);
        let _ = std::fs::remove_file(notes_dir.join(format!("{node_id}.md")));
        let _ = std::fs::remove_file(transcript_path);
        return Err(error.to_string());
    }
    ensure_default_stages_for_node(conn, &node_id).map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &node_id,
        "voice.transcribe",
        &StageUpdate::pending("Waiting for audio"),
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &node_id,
        "voice.summarize",
        &StageUpdate {
            state: StageState::Skipped,
            message: Some("Summary unavailable until transcript is complete".to_string()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        },
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &node_id,
        "search.index",
        &StageUpdate::pending("Waiting for transcript"),
    )
    .map_err(|error| error.to_string())?;

    let voice_note = get_voice_note(conn, &node_id)?
        .ok_or_else(|| "voice note metadata was not created".to_string())?;
    let snapshot = list_snapshot(conn).map_err(|error| error.to_string())?;

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
              voice_notes.note_id,
              nodes.name AS name,
              voice_notes.status,
              voice_notes.capture_status,
              voice_notes.transcription_status,
              voice_notes.summary_status,
              voice_notes.source_audio_path,
              voice_notes.source_audio_deleted_at,
              voice_notes.transcript_path,
              voice_notes.transcript_updated_at,
              voice_notes.speaker_labels_json,
              voice_notes.created_at,
              voice_notes.updated_at
            FROM voice_notes
            INNER JOIN nodes ON nodes.id = voice_notes.note_id
            ORDER BY voice_notes.updated_at DESC, voice_notes.created_at DESC
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
          voice_notes.note_id,
          nodes.name AS name,
          voice_notes.status,
          voice_notes.capture_status,
          voice_notes.transcription_status,
          voice_notes.summary_status,
          voice_notes.source_audio_path,
          voice_notes.source_audio_deleted_at,
          voice_notes.transcript_path,
          voice_notes.transcript_updated_at,
          voice_notes.speaker_labels_json,
          voice_notes.created_at,
          voice_notes.updated_at
        FROM voice_notes
        INNER JOIN nodes ON nodes.id = voice_notes.note_id
        WHERE voice_notes.note_id = ?1
        ",
        [note_id],
        VoiceNoteDto::from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn get_voice_note_transcript(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
) -> Result<String, String> {
    get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    read_voice_note_transcript_file(conn, note_id, notes_dir)
}

fn voice_note_title_for_current_time(conn: &Connection) -> Result<String, String> {
    conn.query_row(
        "SELECT strftime('%Y-%m-%d %H.%M.%S', 'now', 'localtime')",
        [],
        |row| row.get::<_, String>(0),
    )
    .map_err(|error| error.to_string())
}

fn default_voice_note_body(_title: &str) -> String {
    format!(
        "{SUMMARY_HEADING}\n\nSummary unavailable until transcript is complete.\n\n{ACTION_ITEMS_HEADING}\n\nNo action items yet.\n"
    )
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

    let existing_transcript = read_voice_note_transcript_file(conn, &input.note_id, notes_dir)?;
    let transcript_to_save = if transcript_has_timestamps(&existing_transcript)
        && !transcript_has_timestamps(transcript)
    {
        existing_transcript.trim()
    } else {
        transcript
    };
    write_voice_note_transcript_file(conn, &input.note_id, notes_dir, transcript_to_save)?;

    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = render_completed_voice_note_body(&existing_body, input);
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
    update_stage(
        conn,
        &input.note_id,
        "voice.transcribe",
        &StageUpdate::succeeded("Transcript completed"),
    )
    .map_err(|error| error.to_string())?;
    let summary_update = if summary_status == "ready" {
        StageUpdate::succeeded("Summary ready")
    } else {
        StageUpdate {
            state: StageState::Skipped,
            message: Some("Summary unavailable".to_string()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        }
    };
    update_stage(conn, &input.note_id, "voice.summarize", &summary_update)
        .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "search.index",
        &StageUpdate::pending("Waiting to index transcript"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after transcript update".to_string())
}

pub fn recover_interrupted_voice_note_processing(
    conn: &Connection,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteProcessingRecovery, String> {
    let interrupted_note_ids = {
        let mut stmt = conn
            .prepare(
                "
                SELECT note_id
                FROM voice_notes
                WHERE status = 'recording'
                   OR capture_status = 'recording'
                ORDER BY updated_at ASC, note_id ASC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    let mut interrupted_recordings = 0;
    for note_id in interrupted_note_ids {
        recover_interrupted_recording(conn, &note_id, notes_dir, emitter)?;
        interrupted_recordings += 1;
    }

    let pending_rows = {
        let mut stmt = conn
            .prepare(
                "
                SELECT note_id, source_audio_path
                FROM voice_notes
                WHERE capture_status = 'completed'
                  AND transcription_status IN ('pending', 'transcribing')
                ORDER BY updated_at ASC, note_id ASC
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    let mut transcription_jobs = Vec::new();
    let mut failed_transcriptions = 0;
    for (note_id, audio_path) in pending_rows {
        let Some(audio_path) = audio_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
        else {
            mark_voice_note_transcription_failed(
                conn,
                &note_id,
                "failed",
                "Audio unavailable after restart",
                notes_dir,
                emitter,
            )?;
            failed_transcriptions += 1;
            continue;
        };
        if !Path::new(&audio_path).exists() {
            mark_voice_note_transcription_failed(
                conn,
                &note_id,
                "failed",
                "Audio unavailable after restart",
                notes_dir,
                emitter,
            )?;
            failed_transcriptions += 1;
            continue;
        }

        conn.execute(
            "
            UPDATE voice_notes
            SET status = 'transcribing',
                transcription_status = 'pending',
                updated_at = CURRENT_TIMESTAMP
            WHERE note_id = ?1
            ",
            [&note_id],
        )
        .map_err(|error| error.to_string())?;
        update_stage(
            conn,
            &note_id,
            "voice.transcribe",
            &StageUpdate::pending("Transcription queued after restart"),
        )
        .map_err(|error| error.to_string())?;
        emit_note_saved(&note_id, emitter);
        transcription_jobs.push(VoiceNoteTranscriptionJob {
            note_id,
            audio_path,
        });
    }

    Ok(VoiceNoteProcessingRecovery {
        interrupted_recordings,
        transcription_jobs,
        failed_transcriptions,
    })
}

fn recover_interrupted_recording(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<(), String> {
    let voice_note =
        get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    remove_file_if_exists(voice_note.source_audio_path.as_deref())?;
    let transcript = read_voice_note_transcript_file(conn, note_id, notes_dir)?;
    if let Some(transcript) = usable_voice_note_transcript(transcript.trim()) {
        complete_voice_note_transcript(
            conn,
            &CompleteVoiceNoteTranscriptInput {
                note_id: note_id.to_string(),
                transcript,
                summary: None,
                action_items: Vec::new(),
                speaker_labels: voice_note.speaker_labels,
            },
            notes_dir,
            emitter,
        )?;
        conn.execute(
            "
            UPDATE voice_notes
            SET capture_status = 'failed',
                source_audio_path = NULL,
                source_audio_deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE note_id = ?1
            ",
            [note_id],
        )
        .map_err(|error| error.to_string())?;
    } else {
        mark_voice_note_transcription_failed(
            conn,
            note_id,
            "failed",
            "Recording was interrupted because the app quit unexpectedly",
            notes_dir,
            emitter,
        )?;
        conn.execute(
            "
            UPDATE voice_notes
            SET capture_status = 'failed',
                source_audio_path = NULL,
                source_audio_deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE note_id = ?1
            ",
            [note_id],
        )
        .map_err(|error| error.to_string())?;
    }
    emit_note_saved(note_id, emitter);
    Ok(())
}

pub fn enqueue_voice_note_summary_job(
    conn: &Connection,
    note_id: &str,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.transcription_status != "completed" {
        return Err("voice note transcript is not completed".to_string());
    }

    enqueue_background_task(conn, note_id, VOICE_SUMMARY_TASK_TYPE, None, 3)?;
    mark_voice_note_summary_queued(conn, note_id, "Summary queued", emitter)?;
    get_voice_note(conn, note_id)?
        .ok_or_else(|| "voice note metadata missing after summary enqueue".to_string())
}

pub fn recover_voice_note_summary_jobs(
    conn: &Connection,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<usize, String> {
    recover_background_tasks(conn, VOICE_SUMMARY_TASK_TYPE)?;

    let mut stmt = conn
        .prepare(
            "
            SELECT t.node_id
            FROM background_tasks t
            JOIN voice_notes v ON v.note_id = t.node_id
            WHERE t.task_type = ?1
              AND t.status = 'queued'
              AND v.transcription_status = 'completed'
            ORDER BY t.updated_at ASC, t.node_id ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([VOICE_SUMMARY_TASK_TYPE], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let note_ids = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    drop(stmt);

    for note_id in &note_ids {
        mark_voice_note_summary_queued(conn, note_id, "Summary queued", emitter)?;
    }
    Ok(note_ids.len())
}

pub fn has_queued_voice_note_summary_jobs(conn: &Connection) -> Result<bool, String> {
    has_queued_background_tasks(conn, VOICE_SUMMARY_TASK_TYPE)
}

pub fn claim_next_voice_note_summary_job(
    conn: &Connection,
) -> Result<Option<VoiceNoteSummaryJob>, String> {
    claim_next_background_task(conn, VOICE_SUMMARY_TASK_TYPE)
}

pub fn complete_voice_note_summary_job(
    conn: &Connection,
    job: &VoiceNoteSummaryJob,
) -> Result<bool, String> {
    complete_background_task(conn, job)
}

pub fn voice_note_summary_job_is_running(
    conn: &Connection,
    job: &VoiceNoteSummaryJob,
) -> Result<bool, String> {
    background_task_is_running(conn, job)
}

pub fn fail_voice_note_summary_job(
    conn: &Connection,
    job: &VoiceNoteSummaryJob,
    message: &str,
    retryable: bool,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteSummaryJobFailure, String> {
    let outcome = fail_background_task(conn, job, message, retryable)?;
    if outcome == BackgroundTaskFailure::Requeued {
        mark_voice_note_summary_queued(conn, &job.node_id, "Summary retry queued", emitter)?;
    }
    Ok(outcome)
}

pub fn cancel_voice_note_summary_jobs(conn: &Connection, note_id: &str) -> Result<(), String> {
    cancel_background_tasks(conn, note_id, VOICE_SUMMARY_TASK_TYPE)
}

fn mark_voice_note_summary_queued(
    conn: &Connection,
    note_id: &str,
    message: &str,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE voice_notes
        SET summary_status = 'pending',
            updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        note_id,
        "voice.summarize",
        &StageUpdate::pending(message),
    )
    .map_err(|error| error.to_string())?;
    emit_note_saved(note_id, emitter);
    Ok(())
}

pub fn begin_voice_note_summary(
    conn: &Connection,
    note_id: &str,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.transcription_status != "completed" {
        return Err("voice note transcript is not completed".to_string());
    }

    conn.execute(
        "
        UPDATE voice_notes
        SET
          summary_status = 'pending',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        note_id,
        "voice.summarize",
        &StageUpdate::running("Summarizing"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(note_id, emitter);

    get_voice_note(conn, note_id)?
        .ok_or_else(|| "voice note metadata missing after summary start".to_string())
}

pub fn complete_voice_note_summary(
    conn: &Connection,
    input: &CompleteVoiceNoteSummaryInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.transcription_status != "completed" {
        return Err("voice note transcript is not completed".to_string());
    }
    let summary = input.summary.trim();
    if summary.is_empty() {
        return Err("voice note summary cannot be blank".to_string());
    }

    let existing_body = get_note_content(&input.note_id, notes_dir)?;
    let body = render_voice_note_summary_body(&existing_body, summary, &input.action_items);
    write_note_content(conn, &input.note_id, &body, notes_dir)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          summary_status = 'ready',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [&input.note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "voice.summarize",
        &StageUpdate::succeeded("Summary ready"),
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "search.index",
        &StageUpdate::pending("Waiting to index summary"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after summary update".to_string())
}

pub fn mark_voice_note_summary_failed(
    conn: &Connection,
    note_id: &str,
    message: &str,
    retryable: bool,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    conn.execute(
        "
        UPDATE voice_notes
        SET
          summary_status = 'failed',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        note_id,
        "voice.summarize",
        &StageUpdate::failed(message, retryable),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(note_id, emitter);

    get_voice_note(conn, note_id)?
        .ok_or_else(|| "voice note metadata missing after summary failure".to_string())
}

pub fn append_voice_note_realtime_transcript(
    conn: &Connection,
    input: &AppendRealtimeTranscriptInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let mut voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.transcription_status == "completed" {
        return Ok(voice_note);
    }

    let transcript = input.transcript.trim();
    if transcript.is_empty() {
        return Ok(voice_note);
    }

    let current_transcript = read_voice_note_transcript_file(conn, &input.note_id, notes_dir)?;
    let existing_transcript = current_transcript.trim();
    let segment_line = format!(
        "[{} - {}] {}",
        format_timestamp(input.start_ms),
        format_timestamp(input.start_ms.saturating_add(input.duration_ms)),
        transcript
    );
    let replacement = if is_transcript_placeholder(existing_transcript) {
        segment_line
    } else {
        format!("{existing_transcript}\n{segment_line}")
    };
    write_voice_note_transcript_file(conn, &input.note_id, notes_dir, &replacement)?;

    for (speaker_id, label) in &input.speaker_labels {
        voice_note
            .speaker_labels
            .entry(speaker_id.clone())
            .or_insert_with(|| label.clone());
    }
    let speaker_labels_json =
        serde_json::to_string(&voice_note.speaker_labels).map_err(|error| error.to_string())?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          transcription_status = 'transcribing',
          transcript_updated_at = CURRENT_TIMESTAMP,
          speaker_labels_json = ?2,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        params![input.note_id, speaker_labels_json],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "voice.transcribe",
        &StageUpdate::running("Transcribing"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after realtime transcript update".to_string())
}

pub fn begin_voice_note_audio_capture(
    conn: &Connection,
    input: &BeginVoiceNoteAudioCaptureInput,
    storage_dir: &Path,
    _notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;

    let audio_dir = voice_note_audio_dir(storage_dir, &input.note_id)?;
    fs::create_dir_all(&audio_dir).map_err(|error| error.to_string())?;
    let extension =
        audio_file_extension(input.file_extension.as_deref(), input.mime_type.as_deref());
    let audio_path = audio_dir.join(format!("source.{extension}"));
    fs::File::create(&audio_path).map_err(|error| error.to_string())?;

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
    update_stage(
        conn,
        &input.note_id,
        "voice.transcribe",
        &StageUpdate::pending("Waiting to transcribe"),
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
    _notes_dir: &Path,
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

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'transcribing',
          capture_status = 'completed',
          transcription_status = CASE
            WHEN transcription_status = 'transcribing' THEN 'transcribing'
            ELSE 'pending'
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [&input.note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "voice.transcribe",
        &StageUpdate::pending("Audio captured"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after audio capture finish".to_string())
}

pub fn mark_voice_note_transcription_failed(
    conn: &Connection,
    note_id: &str,
    transcription_status: &str,
    message: &str,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    if !matches!(transcription_status, "failed" | "unavailable") {
        return Err("invalid transcription failure status".to_string());
    }

    let voice_note =
        get_voice_note(conn, note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    if voice_note.transcription_status == "completed" {
        return Ok(voice_note);
    }
    let current_transcript = read_voice_note_transcript_file(conn, note_id, notes_dir)?;
    let existing_transcript = current_transcript.trim();
    if let Some(transcript) = usable_voice_note_transcript(existing_transcript) {
        return complete_voice_note_transcript(
            conn,
            &CompleteVoiceNoteTranscriptInput {
                note_id: note_id.to_string(),
                transcript,
                summary: None,
                action_items: Vec::new(),
                speaker_labels: voice_note.speaker_labels,
            },
            notes_dir,
            emitter,
        );
    }

    let prefix = if transcription_status == "unavailable" {
        "Transcription unavailable"
    } else {
        "Transcription failed"
    };
    let failure_text = format!("{prefix}: {}", one_line_message(message));
    let transcript_text = if is_transcript_placeholder(existing_transcript) {
        failure_text
    } else {
        format!("{existing_transcript}\n\n{failure_text}")
    };
    write_voice_note_transcript_file(conn, note_id, notes_dir, &transcript_text)?;

    let existing_body = get_note_content(note_id, notes_dir)?;
    let body = remove_voice_note_transcript_section(&existing_body);
    write_note_content(conn, note_id, &body, notes_dir)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'failed',
          transcription_status = ?2,
          transcript_updated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        params![note_id, transcription_status],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        note_id,
        "voice.transcribe",
        &StageUpdate::failed(message, transcription_status != "failed"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(note_id, emitter);

    get_voice_note(conn, note_id)?
        .ok_or_else(|| "voice note metadata missing after transcription failure".to_string())
}

pub fn begin_voice_note_retranscription(
    conn: &Connection,
    input: &VoiceNoteInput,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<VoiceNoteDto, String> {
    let voice_note =
        get_voice_note(conn, &input.note_id)?.ok_or_else(|| "voice note not found".to_string())?;
    let source_audio_path = voice_note
        .source_audio_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "voice note has no source audio to retranscribe".to_string())?;
    if !Path::new(source_audio_path).exists() {
        return Err("voice note source audio file is missing".to_string());
    }
    cancel_voice_note_summary_jobs(conn, &input.note_id)?;

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'transcribing',
          transcription_status = 'transcribing',
          summary_status = 'unavailable',
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [&input.note_id],
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "voice.transcribe",
        &StageUpdate::running("Retranscribing from source audio"),
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "voice.summarize",
        &StageUpdate {
            state: StageState::Skipped,
            message: Some("Summary unavailable".to_string()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        },
    )
    .map_err(|error| error.to_string())?;
    update_stage(
        conn,
        &input.note_id,
        "search.index",
        &StageUpdate::pending("Waiting for transcript"),
    )
    .map_err(|error| error.to_string())?;

    emit_note_saved(&input.note_id, emitter);

    get_voice_note(conn, &input.note_id)?
        .ok_or_else(|| "voice note metadata missing after retranscription start".to_string())
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
    _notes_dir: &Path,
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

pub fn delete_voice_note_artifacts(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
) -> Result<(), String> {
    let paths = conn
        .query_row(
            "
            SELECT source_audio_path, transcript_path
            FROM voice_notes
            WHERE note_id = ?1
            ",
            [note_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>("source_audio_path")?,
                    row.get::<_, Option<String>>("transcript_path")?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some((source_audio_path, transcript_path)) = paths {
        remove_file_if_exists(source_audio_path.as_deref())?;
        remove_file_if_exists(transcript_path.as_deref())?;
    }

    if let Some(storage_dir) = notes_dir.parent() {
        let artifact_dir = voice_note_audio_dir(storage_dir, note_id)?;
        if artifact_dir.exists() {
            fs::remove_dir_all(&artifact_dir).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

fn render_completed_voice_note_body(
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

    let without_transcript = remove_voice_note_transcript_section(existing_body);
    let without_source = remove_markdown_section(&without_transcript, "## Source Audio");
    let with_summary = replace_markdown_section(&without_source, SUMMARY_HEADING, summary);
    replace_markdown_section(&with_summary, ACTION_ITEMS_HEADING, &action_items)
}

fn render_voice_note_summary_body(
    existing_body: &str,
    summary: &str,
    action_items: &[String],
) -> String {
    let action_items = if action_items.is_empty() {
        "No action items yet.".to_string()
    } else {
        action_items
            .iter()
            .map(|item| format!("- {}", item.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let with_summary = replace_markdown_section(existing_body, SUMMARY_HEADING, summary);
    replace_markdown_section(&with_summary, ACTION_ITEMS_HEADING, &action_items)
}

fn replace_markdown_section(existing: &str, heading: &str, replacement: &str) -> String {
    let existing = strip_legacy_voice_note_markers(existing);
    let Some(start_index) = existing.find(heading) else {
        return append_markdown_section(&existing, heading, replacement);
    };
    let content_start = start_index + heading.len();
    let rest = &existing[content_start..];
    let relative_end_index = rest.find("\n## ").unwrap_or(rest.len());
    let end_index = content_start + relative_end_index;
    format!(
        "{}\n\n{}\n{}",
        existing[..content_start].trim_end(),
        replacement.trim(),
        existing[end_index..].trim_start_matches('\n')
    )
}

fn append_markdown_section(existing: &str, heading: &str, replacement: &str) -> String {
    let existing = existing.trim_end();
    if existing.is_empty() {
        format!("{heading}\n\n{}\n", replacement.trim())
    } else {
        format!("{existing}\n\n{heading}\n\n{}\n", replacement.trim())
    }
}

fn remove_markdown_section(existing: &str, heading: &str) -> String {
    let existing = strip_legacy_voice_note_markers(existing);
    let Some(start_index) = existing.find(heading) else {
        return existing;
    };
    let content_start = start_index + heading.len();
    let rest = &existing[content_start..];
    let relative_end_index = rest.find("\n## ").unwrap_or(rest.len());
    let end_index = content_start + relative_end_index;
    let before = existing[..start_index].trim_end();
    let after = existing[end_index..].trim_start();
    if before.is_empty() {
        if after.is_empty() {
            String::new()
        } else {
            format!("{after}\n")
        }
    } else if after.is_empty() {
        format!("{before}\n")
    } else {
        format!("{before}\n\n{after}")
    }
}

fn strip_legacy_voice_note_markers(existing: &str) -> String {
    existing
        .replace("<!-- voice-note:source:start -->", "")
        .replace("<!-- voice-note:source:end -->", "")
        .replace(SUMMARY_START, "")
        .replace(SUMMARY_END, "")
        .replace(ACTION_ITEMS_START, "")
        .replace(ACTION_ITEMS_END, "")
}

fn remove_voice_note_transcript_section(existing: &str) -> String {
    let Some(start_index) = existing.find(TRANSCRIPT_START) else {
        return existing.to_string();
    };
    let content_start = start_index + TRANSCRIPT_START.len();
    let Some(relative_end_index) = existing[content_start..].find(TRANSCRIPT_END) else {
        return existing.to_string();
    };
    let mut remove_start = start_index;
    if let Some(heading_index) = existing[..start_index].rfind("## Transcript") {
        let between_heading_and_marker =
            &existing[heading_index + "## Transcript".len()..start_index];
        if between_heading_and_marker.trim().is_empty() {
            remove_start = heading_index;
        }
    }

    let mut remove_end = content_start + relative_end_index + TRANSCRIPT_END.len();
    while remove_end < existing.len() && existing.as_bytes()[remove_end].is_ascii_whitespace() {
        remove_end += 1;
    }

    let before = existing[..remove_start].trim_end();
    let after = existing[remove_end..].trim_start();
    if before.is_empty() {
        if after.is_empty() {
            String::new()
        } else {
            format!("{after}\n")
        }
    } else if after.is_empty() {
        format!("{before}\n")
    } else {
        format!("{before}\n\n{after}")
    }
}

fn is_transcript_placeholder(text: &str) -> bool {
    text.is_empty()
        || text == "Transcription pending."
        || text.starts_with("Transcription failed:")
        || text.starts_with("Transcription unavailable:")
}

fn usable_voice_note_transcript(text: &str) -> Option<String> {
    let transcript = text
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("Transcription failed:")
                && !trimmed.starts_with("Transcription unavailable:")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let transcript = transcript.trim();
    if transcript.is_empty() || transcript == "Transcription pending." {
        None
    } else {
        Some(transcript.to_string())
    }
}

fn transcript_has_timestamps(text: &str) -> bool {
    text.lines()
        .any(|line| transcript_line_timestamp_ms(line).is_some())
}

fn transcript_line_timestamp_ms(line: &str) -> Option<u64> {
    let line = line.trim_start();
    let rest = line.strip_prefix('[')?;
    let end = rest.find(']')?;
    let range_or_timestamp = &rest[..end];
    let start = range_or_timestamp
        .split_once('-')
        .map(|(start, _)| start)
        .unwrap_or(range_or_timestamp)
        .trim();
    parse_timestamp_ms(start)
}

fn parse_timestamp_ms(raw: &str) -> Option<u64> {
    let (minutes, seconds) = raw.split_once(':')?;
    let minutes = minutes.parse::<u64>().ok()?;
    let (seconds, millis) = seconds
        .split_once('.')
        .map(|(seconds, millis)| (seconds, millis))
        .unwrap_or((seconds, "0"));
    let seconds = seconds.parse::<u64>().ok()?;
    if seconds >= 60 {
        return None;
    }
    let millis = match millis.len() {
        0 => 0,
        1 => millis.parse::<u64>().ok()? * 100,
        2 => millis.parse::<u64>().ok()? * 10,
        _ => millis[..3].parse::<u64>().ok()?,
    };
    Some(minutes * 60_000 + seconds * 1_000 + millis)
}

fn read_voice_note_transcript_file(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
) -> Result<String, String> {
    let path = voice_note_transcript_path_from_db(conn, note_id, notes_dir)?;
    match fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => Ok(content),
        Ok(_) => Ok(legacy_voice_note_transcript(note_id, notes_dir).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(legacy_voice_note_transcript(note_id, notes_dir).unwrap_or_default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_voice_note_transcript_file(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
    transcript: &str,
) -> Result<(), String> {
    let path = voice_note_transcript_path_from_db(conn, note_id, notes_dir)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, transcript.as_bytes()).map_err(|error| error.to_string())?;
    conn.execute(
        "
        UPDATE voice_notes
        SET transcript_path = ?2
        WHERE note_id = ?1
        ",
        params![note_id, path.to_string_lossy().to_string()],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [note_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn voice_note_transcript_path_from_db(
    conn: &Connection,
    note_id: &str,
    notes_dir: &Path,
) -> Result<PathBuf, String> {
    let stored = conn
        .query_row(
            "SELECT transcript_path FROM voice_notes WHERE note_id = ?1",
            [note_id],
            |row| row.get::<_, Option<String>>("transcript_path"),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if let Some(stored) = stored.filter(|path| !path.trim().is_empty()) {
        return Ok(PathBuf::from(stored));
    }
    voice_note_transcript_path_for_notes_dir(notes_dir, note_id)
}

fn voice_note_transcript_path_for_notes_dir(
    notes_dir: &Path,
    note_id: &str,
) -> Result<PathBuf, String> {
    let storage_dir = notes_dir
        .parent()
        .ok_or_else(|| "notes directory has no storage parent".to_string())?;
    Ok(voice_note_audio_dir(storage_dir, note_id)?.join("transcript.md"))
}

fn legacy_voice_note_transcript(note_id: &str, notes_dir: &Path) -> Option<String> {
    let body = get_note_content(note_id, notes_dir).ok()?;
    let start_index = body.find(TRANSCRIPT_START)?;
    let content_start = start_index + TRANSCRIPT_START.len();
    let relative_end_index = body[content_start..].find(TRANSCRIPT_END)?;
    let end_index = content_start + relative_end_index;
    let transcript = body[content_start..end_index].trim();
    if is_transcript_placeholder(transcript) {
        None
    } else {
        Some(transcript.to_string())
    }
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

pub fn mark_voice_note_capture_failed(conn: &Connection, note_id: &str) -> Result<(), String> {
    let source_audio_path = conn
        .query_row(
            "
            SELECT source_audio_path
            FROM voice_notes
            WHERE note_id = ?1
            ",
            [note_id],
            |row| row.get::<_, Option<String>>("source_audio_path"),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if let Some(path) = source_audio_path.as_deref() {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.to_string());
            }
        }
    }

    conn.execute(
        "
        UPDATE voice_notes
        SET
          status = 'failed',
          capture_status = 'failed',
          source_audio_path = NULL,
          source_audio_deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE note_id = ?1
        ",
        [note_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn remove_file_if_exists(path: Option<&str>) -> Result<(), String> {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn format_timestamp(duration_ms: u64) -> String {
    let total_seconds = duration_ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    let millis = duration_ms % 1_000;
    format!("{minutes:02}:{seconds:02}.{millis:03}")
}

fn one_line_message(message: &str) -> String {
    let text = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        "No detail provided.".to_string()
    } else {
        text
    }
}
