use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;

use rusqlite::params;
use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::notes::get_note_content::get_note_content;
use cognios_lib::services::notes::save_note_content::save_note_content;
use cognios_lib::services::voice_notes::{
    append_voice_note_audio_chunk, append_voice_note_realtime_transcript,
    begin_voice_note_audio_capture, begin_voice_note_retranscription, begin_voice_note_summary,
    capture_capability, claim_next_voice_note_summary_job, complete_voice_note_summary,
    complete_voice_note_summary_job, complete_voice_note_transcript, create_voice_note,
    delete_voice_note_source_audio, enqueue_voice_note_summary_job, fail_voice_note_summary_job,
    finish_voice_note_audio_capture, get_voice_note, get_voice_note_transcript,
    mark_voice_note_transcription_failed, recover_interrupted_voice_note_processing,
    recover_voice_note_summary_jobs, rename_voice_note_speaker, AppendRealtimeTranscriptInput,
    AppendVoiceNoteAudioChunkInput, BeginVoiceNoteAudioCaptureInput, CompleteVoiceNoteSummaryInput,
    CompleteVoiceNoteTranscriptInput, CreateVoiceNoteInput, FinishVoiceNoteAudioCaptureInput,
    RenameVoiceNoteSpeakerInput, VoiceNoteInput, VoiceNoteSummaryJobFailure,
};

fn noop_emitter(_event: VfsChangeEvent) {}

fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let app_dir = tempdir().expect("app tempdir");
    let db_path = app_dir.path().join("cognios.db");
    let notes_dir = app_dir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    (app_dir, db_path, notes_dir)
}

#[test]
fn create_voice_note_creates_note_file_and_metadata() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    assert_eq!(created.snapshot.roots.len(), 1);
    assert_eq!(created.snapshot.roots[0].kind, "note");
    assert!(created.snapshot.roots[0].is_voice_note);
    assert_eq!(created.voice_note.note_id, created.snapshot.roots[0].id);
    assert!(!created.voice_note.name.starts_with("Voice Note "));
    assert_eq!(created.voice_note.name.len(), "2026-05-11 10.00.00".len());
    assert_eq!(created.voice_note.name, created.snapshot.roots[0].name);
    assert_eq!(created.voice_note.status, "pending_audio");
    assert_eq!(created.voice_note.capture_status, "unsupported");
    assert_eq!(created.voice_note.transcription_status, "pending");
    assert!(!created.voice_note.source_audio_present);
    let transcript_path = created
        .voice_note
        .transcript_path
        .as_deref()
        .expect("transcript path");
    assert!(transcript_path.ends_with("transcript.md"));
    assert!(std::path::Path::new(transcript_path).exists());

    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(body.starts_with("## Summary\n\n"));
    assert!(!body.contains("## Source Audio"));
    assert!(!body.contains("<!-- voice-note:"));
    assert!(!body.contains("## Transcript"));
    assert!(!body.contains("Transcription pending."));
    assert_eq!(
        get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
            .expect("transcript"),
        ""
    );
}

#[test]
fn complete_transcript_saves_markdown_and_marks_voice_note_completed() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    let events = RefCell::new(Vec::<VfsChangeEvent>::new());
    let recording_emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);

    let updated = complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "[00:00.000] Speaker 1: hello\n[00:01.250] Speaker 2: hi".into(),
            summary: Some("Two people greeted each other.".into()),
            action_items: vec!["Follow up with Speaker 2".into()],
            speaker_labels: BTreeMap::from([
                ("speaker_1".into(), "Speaker 1".into()),
                ("speaker_2".into(), "Speaker 2".into()),
            ]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("complete transcript");

    assert_eq!(updated.status, "completed");
    assert_eq!(updated.transcription_status, "completed");
    assert_eq!(updated.summary_status, "ready");
    assert!(updated.transcript_updated_at.is_some());
    assert_eq!(updated.speaker_labels["speaker_1"], "Speaker 1");

    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("[00:01.250] Speaker 2: hi"));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("## Source Audio"));
    assert!(!body.contains("<!-- voice-note:"));
    assert!(!body.contains("[00:01.250] Speaker 2: hi"));
    assert!(body.contains("- Follow up with Speaker 2"));
    assert!(
        events
            .borrow()
            .iter()
            .any(|event| event.mount_id == created.voice_note.note_id
                && event.reason == "node-saved"),
        "completed transcript should use the normal note save event for search indexing"
    );
}

#[test]
fn retranscription_requires_source_audio_and_marks_voice_note_transcribing() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &noop_emitter,
    )
    .expect("begin capture");
    append_voice_note_audio_chunk(
        &conn,
        &AppendVoiceNoteAudioChunkInput {
            note_id: created.voice_note.note_id.clone(),
            bytes: b"audio".to_vec(),
        },
    )
    .expect("append audio");
    finish_voice_note_audio_capture(
        &conn,
        &FinishVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            duration_ms: Some(1_000),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("finish capture");
    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "[00:00.000] Speaker 1: original".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");

    let retranscribing = begin_voice_note_retranscription(
        &conn,
        &VoiceNoteInput {
            note_id: created.voice_note.note_id.clone(),
        },
        &noop_emitter,
    )
    .expect("begin retranscription");

    assert_eq!(retranscribing.status, "transcribing");
    assert_eq!(retranscribing.transcription_status, "transcribing");
    assert_eq!(retranscribing.summary_status, "unavailable");
}

#[test]
fn summary_completion_updates_markdown_and_status_after_transcript() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "[00:00.000] Speaker 1: launch update".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");

    let summarizing = begin_voice_note_summary(&conn, &created.voice_note.note_id, &noop_emitter)
        .expect("begin summary");
    assert_eq!(summarizing.summary_status, "pending");

    let summarized = complete_voice_note_summary(
        &conn,
        &CompleteVoiceNoteSummaryInput {
            note_id: created.voice_note.note_id.clone(),
            summary: "They discussed the launch.".into(),
            action_items: vec!["Ship the build".into()],
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete summary");

    assert_eq!(summarized.summary_status, "ready");
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("<!-- voice-note:"));
    assert!(body.contains("They discussed the launch."));
    assert!(body.contains("- Ship the build"));
}

#[test]
fn summary_jobs_recover_running_work_after_restart() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: summarize this after restart".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");
    enqueue_voice_note_summary_job(&conn, &created.voice_note.note_id, &noop_emitter)
        .expect("enqueue summary");

    let first_claim = claim_next_voice_note_summary_job(&conn)
        .expect("claim")
        .expect("queued job");
    assert_eq!(first_claim.node_id, created.voice_note.note_id);
    assert_eq!(first_claim.attempt, 1);

    let recovered =
        recover_voice_note_summary_jobs(&conn, &noop_emitter).expect("recover running job");
    assert_eq!(recovered, 1);
    let second_claim = claim_next_voice_note_summary_job(&conn)
        .expect("claim after recovery")
        .expect("recovered job");
    assert_eq!(second_claim.node_id, first_claim.node_id);
    assert_eq!(second_claim.generation, first_claim.generation);
    assert_eq!(second_claim.attempt, 2);
}

#[test]
fn summary_job_generation_ignores_stale_results() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: first transcript".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");
    enqueue_voice_note_summary_job(&conn, &created.voice_note.note_id, &noop_emitter)
        .expect("enqueue first summary");
    let stale_job = claim_next_voice_note_summary_job(&conn)
        .expect("claim first")
        .expect("first job");

    enqueue_voice_note_summary_job(&conn, &created.voice_note.note_id, &noop_emitter)
        .expect("enqueue replacement summary");

    assert!(
        !complete_voice_note_summary_job(&conn, &stale_job).expect("complete stale"),
        "old generation must not be allowed to complete"
    );
    assert_eq!(
        fail_voice_note_summary_job(&conn, &stale_job, "old result", true, &noop_emitter)
            .expect("fail stale"),
        VoiceNoteSummaryJobFailure::Stale
    );
    let replacement_job = claim_next_voice_note_summary_job(&conn)
        .expect("claim replacement")
        .expect("replacement job");
    assert_eq!(replacement_job.node_id, stale_job.node_id);
    assert!(replacement_job.generation > stale_job.generation);
}

#[test]
fn audio_capture_writes_source_file_and_marks_transcription_pending() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let events = RefCell::new(Vec::<VfsChangeEvent>::new());
    let recording_emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    let recording = begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/webm;codecs=opus".into()),
            file_extension: None,
        },
        app_dir.path(),
        &notes_dir,
        &recording_emitter,
    )
    .expect("begin capture");

    assert_eq!(recording.status, "recording");
    assert_eq!(recording.capture_status, "recording");
    assert!(recording.source_audio_present);
    let audio_path = recording.source_audio_path.as_deref().expect("source path");
    assert!(audio_path.ends_with("source.webm"));

    append_voice_note_audio_chunk(
        &conn,
        &AppendVoiceNoteAudioChunkInput {
            note_id: created.voice_note.note_id.clone(),
            bytes: b"first ".to_vec(),
        },
    )
    .expect("append first chunk");
    append_voice_note_audio_chunk(
        &conn,
        &AppendVoiceNoteAudioChunkInput {
            note_id: created.voice_note.note_id.clone(),
            bytes: b"second".to_vec(),
        },
    )
    .expect("append second chunk");
    assert_eq!(fs::read(audio_path).expect("audio bytes"), b"first second");

    let finished = finish_voice_note_audio_capture(
        &conn,
        &FinishVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            duration_ms: Some(1_250),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("finish capture");

    assert_eq!(finished.status, "transcribing");
    assert_eq!(finished.capture_status, "completed");
    assert_eq!(finished.transcription_status, "pending");
    assert!(finished.source_audio_present);
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("## Source Audio"));
    assert!(!body.contains("Source audio saved locally"));
    assert!(!body.contains("Transcription pending."));
    assert!(
        events
            .borrow()
            .iter()
            .any(|event| event.mount_id == created.voice_note.note_id
                && event.reason == "node-saved"),
        "audio capture changes should refresh the note"
    );
}

#[test]
fn startup_recovery_marks_interrupted_recordings_failed() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    let recording = begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &noop_emitter,
    )
    .expect("begin capture");
    let audio_path = recording.source_audio_path.as_deref().expect("source path");
    fs::write(audio_path, b"partial audio").expect("partial audio");

    let recovery = recover_interrupted_voice_note_processing(&conn, &notes_dir, &noop_emitter)
        .expect("recover interrupted recording");

    assert_eq!(recovery.interrupted_recordings, 1);
    assert!(recovery.transcription_jobs.is_empty());
    assert!(!std::path::Path::new(audio_path).exists());
    let recovered = get_voice_note(&conn, &created.voice_note.note_id)
        .expect("voice note")
        .expect("exists");
    assert_eq!(recovered.status, "failed");
    assert_eq!(recovered.capture_status, "failed");
    assert_eq!(recovered.transcription_status, "failed");
    assert!(recovered.source_audio_path.is_none());
}

#[test]
fn startup_recovery_requeues_completed_audio_transcription() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &noop_emitter,
    )
    .expect("begin capture");
    append_voice_note_audio_chunk(
        &conn,
        &AppendVoiceNoteAudioChunkInput {
            note_id: created.voice_note.note_id.clone(),
            bytes: b"audio".to_vec(),
        },
    )
    .expect("append audio");
    let finished = finish_voice_note_audio_capture(
        &conn,
        &FinishVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            duration_ms: Some(1_000),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("finish capture");
    conn.execute(
        "
        UPDATE voice_notes
        SET transcription_status = 'transcribing'
        WHERE note_id = ?1
        ",
        [&created.voice_note.note_id],
    )
    .expect("simulate interrupted transcription");

    let recovery = recover_interrupted_voice_note_processing(&conn, &notes_dir, &noop_emitter)
        .expect("recover pending transcription");

    assert_eq!(recovery.interrupted_recordings, 0);
    assert_eq!(recovery.failed_transcriptions, 0);
    assert_eq!(recovery.transcription_jobs.len(), 1);
    assert_eq!(
        recovery.transcription_jobs[0].note_id,
        created.voice_note.note_id
    );
    assert_eq!(
        recovery.transcription_jobs[0].audio_path,
        finished.source_audio_path.expect("source audio")
    );
    let recovered = get_voice_note(&conn, &created.voice_note.note_id)
        .expect("voice note")
        .expect("exists");
    assert_eq!(recovered.status, "transcribing");
    assert_eq!(recovered.capture_status, "completed");
    assert_eq!(recovered.transcription_status, "pending");
}

#[test]
fn realtime_transcript_appends_timestamped_lines_without_completing_note() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let events = RefCell::new(Vec::<VfsChangeEvent>::new());
    let recording_emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &recording_emitter,
    )
    .expect("begin capture");

    let first = append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: first live sentence".into(),
            start_ms: 0,
            duration_ms: 1_250,
            speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("append first realtime transcript");
    let second = append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: second live sentence".into(),
            start_ms: 5_250,
            duration_ms: 2_000,
            speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("append second realtime transcript");

    assert_eq!(first.status, "recording");
    assert_eq!(second.status, "recording");
    assert_eq!(second.transcription_status, "transcribing");
    assert_eq!(second.speaker_labels["speaker_1"], "Speaker 1");
    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("[00:00.000 - 00:01.250] Speaker 1: first live sentence"));
    assert!(transcript.contains("[00:05.250 - 00:07.250] Speaker 1: second live sentence"));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("[00:00.000 - 00:01.250] Speaker 1: first live sentence"));
    assert!(
        events
            .borrow()
            .iter()
            .any(|event| event.mount_id == created.voice_note.note_id
                && event.reason == "node-saved"),
        "realtime transcript appends should refresh the note"
    );
}

#[test]
fn realtime_transcript_replaces_overlapping_windowed_lines_with_full_utterance() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let recording_emitter = |_event: VfsChangeEvent| {};
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &recording_emitter,
    )
    .expect("begin capture");

    for (start_ms, transcript) in [
        (0, "Speaker 1: 那我们试一下最新的这个。"),
        (2_000, "Speaker 1: A transceiver."),
    ] {
        append_voice_note_realtime_transcript(
            &conn,
            &AppendRealtimeTranscriptInput {
                note_id: created.voice_note.note_id.clone(),
                transcript: transcript.into(),
                start_ms,
                duration_ms: 2_000,
                speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
            },
            &notes_dir,
            &recording_emitter,
        )
        .expect("append windowed realtime transcript");
    }

    append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: 那我们试一下最新的这个TransGrid。".into(),
            start_ms: 579,
            duration_ms: 2_805,
            speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("append full realtime utterance");

    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(!transcript.contains("[00:00.000 - 00:02.000]"));
    assert!(!transcript.contains("[00:02.000 - 00:04.000]"));
    assert!(
        transcript.contains("[00:00.579 - 00:03.384] Speaker 1: 那我们试一下最新的这个TransGrid。")
    );
}

#[test]
fn realtime_transcript_skips_shorter_overlap_after_full_utterance() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let recording_emitter = |_event: VfsChangeEvent| {};
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/wav".into()),
            file_extension: Some("wav".into()),
        },
        app_dir.path(),
        &notes_dir,
        &recording_emitter,
    )
    .expect("begin capture");

    append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: complete utterance".into(),
            start_ms: 579,
            duration_ms: 2_805,
            speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("append full realtime utterance");
    append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: partial window".into(),
            start_ms: 0,
            duration_ms: 2_000,
            speaker_labels: BTreeMap::from([("speaker_1".into(), "Speaker 1".into())]),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("append overlapping windowed transcript");

    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("[00:00.579 - 00:03.384] Speaker 1: complete utterance"));
    assert!(!transcript.contains("partial window"));
}

#[test]
fn empty_audio_capture_failure_clears_unplayable_source_audio() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    let recording = begin_voice_note_audio_capture(
        &conn,
        &BeginVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            mime_type: Some("audio/webm;codecs=opus".into()),
            file_extension: None,
        },
        app_dir.path(),
        &notes_dir,
        &noop_emitter,
    )
    .expect("begin capture");
    let audio_path = recording.source_audio_path.as_deref().expect("source path");
    assert!(std::path::Path::new(audio_path).exists());

    let error = finish_voice_note_audio_capture(
        &conn,
        &FinishVoiceNoteAudioCaptureInput {
            note_id: created.voice_note.note_id.clone(),
            duration_ms: Some(0),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect_err("empty source audio rejected");

    assert!(error.contains("voice note source audio is empty"));
    assert!(!std::path::Path::new(audio_path).exists());
    let failed = get_voice_note(&conn, &created.voice_note.note_id)
        .expect("voice note")
        .expect("voice note exists");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.capture_status, "failed");
    assert!(!failed.source_audio_present);
    assert!(failed.source_audio_path.is_none());
    assert!(failed.source_audio_deleted_at.is_some());
}

#[test]
fn complete_transcript_preserves_user_content_outside_voice_note_sections() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    let custom_body = format!(
        "{}\n\n## User Notes\n\nKeep this decision.",
        get_note_content(&created.voice_note.note_id, &notes_dir).expect("body")
    );
    save_note_content(
        &conn,
        &created.voice_note.note_id,
        &custom_body,
        &notes_dir,
        &noop_emitter,
    )
    .expect("save user edit");

    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: shipping update".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");

    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("Speaker 1: shipping update"));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("Speaker 1: shipping update"));
    assert!(body.contains("## User Notes\n\nKeep this decision."));
}

#[test]
fn complete_transcript_rejects_blank_or_already_completed_transcripts() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    let blank = complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "   ".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect_err("blank transcript rejected");
    assert!(blank.contains("cannot be blank"));

    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: first final transcript".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("first completion");

    let second = complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id,
            transcript: "Speaker 1: replacement transcript".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect_err("second completion rejected");
    assert!(second.contains("already completed"));
}

#[test]
fn delete_source_audio_preserves_transcript_content() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let events = RefCell::new(Vec::<VfsChangeEvent>::new());
    let recording_emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: source can be deleted".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");

    let audio_path = app_dir.path().join("source.wav");
    fs::write(&audio_path, b"audio").expect("source audio");
    conn.execute(
        "UPDATE voice_notes SET source_audio_path = ?2 WHERE note_id = ?1",
        params![
            &created.voice_note.note_id,
            audio_path.to_string_lossy().to_string()
        ],
    )
    .expect("attach source path");

    let updated = delete_voice_note_source_audio(
        &conn,
        &VoiceNoteInput {
            note_id: created.voice_note.note_id.clone(),
        },
        &notes_dir,
        &recording_emitter,
    )
    .expect("delete source audio");

    assert!(!audio_path.exists());
    assert!(!updated.source_audio_present);
    assert!(updated.source_audio_path.is_none());
    assert!(updated.source_audio_deleted_at.is_some());
    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("Speaker 1: source can be deleted"));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("Speaker 1: source can be deleted"));
    assert!(!body.contains("## Source Audio"));
    assert!(!body.contains("Source audio has been deleted."));
    assert!(
        events
            .borrow()
            .iter()
            .any(|event| event.mount_id == created.voice_note.note_id
                && event.reason == "node-saved"),
        "source audio deletion should refresh indexed note content"
    );
}

#[test]
fn deleting_voice_note_node_removes_attached_audio_and_transcript_artifacts() {
    let (app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    let note_id = created.voice_note.note_id.clone();
    let artifact_dir = app_dir.path().join("voice-notes").join(&note_id);
    assert!(artifact_dir.exists(), "default artifact dir exists");

    let external_audio_path = app_dir.path().join("attached-source.wav");
    let external_transcript_path = app_dir.path().join("attached-transcript.md");
    fs::write(&external_audio_path, b"recording").expect("external source audio");
    fs::write(&external_transcript_path, "transcript").expect("external transcript");
    conn.execute(
        "
        UPDATE voice_notes
        SET source_audio_path = ?2, transcript_path = ?3
        WHERE note_id = ?1
        ",
        params![
            &note_id,
            external_audio_path.to_string_lossy().to_string(),
            external_transcript_path.to_string_lossy().to_string()
        ],
    )
    .expect("attach artifact paths");

    delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: note_id.clone(),
            cascade: None,
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("delete voice note");

    assert!(!notes_dir.join(format!("{note_id}.md")).exists());
    assert!(!artifact_dir.exists(), "default artifact dir removed");
    assert!(!external_audio_path.exists(), "source recording removed");
    assert!(
        !external_transcript_path.exists(),
        "transcript artifact removed"
    );
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM voice_notes WHERE note_id = ?1",
            [&note_id],
            |row| row.get(0),
        )
        .expect("voice note count");
    assert_eq!(remaining, 0, "voice note metadata removed by node delete");
}

#[test]
fn mark_transcription_unavailable_updates_metadata_and_transcript_file() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");
    let events = RefCell::new(Vec::<VfsChangeEvent>::new());
    let recording_emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);

    let updated = mark_voice_note_transcription_failed(
        &conn,
        &created.voice_note.note_id,
        "unavailable",
        "Qwen ASR ONNX runtime script is missing\nredownload the voice-note model",
        &notes_dir,
        &recording_emitter,
    )
    .expect("mark unavailable");

    assert_eq!(updated.status, "failed");
    assert_eq!(updated.transcription_status, "unavailable");
    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains(
        "Transcription unavailable: Qwen ASR ONNX runtime script is missing redownload the voice-note model"
    ));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("Qwen ASR ONNX runtime script is missing"));
    assert!(
        events
            .borrow()
            .iter()
            .any(|event| event.mount_id == created.voice_note.note_id
                && event.reason == "node-saved"),
        "transcription failure should refresh the note"
    );
}

#[test]
fn transcription_failure_completes_existing_realtime_transcript() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: live transcript survived".into(),
            start_ms: 1_500,
            duration_ms: 2_000,
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("append realtime transcript");

    let updated = mark_voice_note_transcription_failed(
        &conn,
        &created.voice_note.note_id,
        "failed",
        "final pass failed",
        &notes_dir,
        &noop_emitter,
    )
    .expect("mark failed");

    assert_eq!(updated.status, "completed");
    assert_eq!(updated.transcription_status, "completed");
    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("[00:01.500 - 00:03.500] Speaker 1: live transcript survived"));
    assert!(!transcript.contains("Transcription failed: final pass failed"));
    let body = get_note_content(&created.voice_note.note_id, &notes_dir).expect("body");
    assert!(!body.contains("live transcript survived"));
    assert!(!body.contains("final pass failed"));
}

#[test]
fn final_transcript_without_timestamps_keeps_realtime_timestamps_for_playback_sync() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    append_voice_note_realtime_transcript(
        &conn,
        &AppendRealtimeTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: timestamped live line".into(),
            start_ms: 2_250,
            duration_ms: 1_500,
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("append realtime transcript");

    complete_voice_note_transcript(
        &conn,
        &CompleteVoiceNoteTranscriptInput {
            note_id: created.voice_note.note_id.clone(),
            transcript: "Speaker 1: final transcript without timestamps".into(),
            summary: None,
            action_items: vec![],
            speaker_labels: BTreeMap::new(),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("complete transcript");

    let transcript = get_voice_note_transcript(&conn, &created.voice_note.note_id, &notes_dir)
        .expect("transcript");
    assert!(transcript.contains("[00:02.250 - 00:03.750] Speaker 1: timestamped live line"));
    assert!(!transcript.contains("Speaker 1: final transcript without timestamps"));
}

#[test]
fn rename_speaker_updates_label_metadata_without_rewriting_transcript() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create voice note");

    let updated = rename_voice_note_speaker(
        &conn,
        &RenameVoiceNoteSpeakerInput {
            note_id: created.voice_note.note_id,
            speaker_id: "speaker_1".into(),
            label: "Alice".into(),
        },
    )
    .expect("rename speaker");

    assert_eq!(updated.speaker_labels["speaker_1"], "Alice");
}

#[test]
fn capture_capability_is_honest_until_system_audio_is_implemented() {
    let capability = capture_capability();

    assert_eq!(
        capability.manual_audio_recording,
        cognios_lib::services::voice_notes::native_audio::microphone_recording_available()
    );
    assert!(!capability.system_audio_recording);
    assert!(!capability.automatic_detection);
    assert!(capability.reason.contains("Automatic meeting detection"));
}
