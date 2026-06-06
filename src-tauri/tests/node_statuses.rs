use rusqlite::params;
use tempfile::tempdir;

use cognios_lib::domain::node_status::{StageState, StageUpdate};
use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::node_status_repository::{
    get_node_status, get_node_status_snapshot, update_stage,
};
use cognios_lib::infrastructure::db::url_repository::{create_url, CreateUrlInput};
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::voice_notes::{create_voice_note, CreateVoiceNoteInput};

fn noop_emitter(_event: VfsChangeEvent) {}

#[test]
fn url_nodes_get_static_crawl_and_index_stages() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: None,
        },
    )
    .expect("url");

    let status = get_node_status(&conn, &created.node_id)
        .expect("status")
        .expect("node status");

    assert_eq!(status.overall, "queued");
    assert_eq!(status.primary_stage_id.as_deref(), Some("url.crawl"));
    assert_eq!(
        status
            .stages
            .iter()
            .map(|stage| stage.id.as_str())
            .collect::<Vec<_>>(),
        vec!["url.crawl", "content.index"]
    );
}

#[test]
fn voice_notes_get_transcribe_summarize_and_index_stages() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let notes_dir = dir.path().join("notes");
    std::fs::create_dir_all(&notes_dir).expect("notes dir");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("voice note");

    let status = get_node_status(&conn, &created.voice_note.note_id)
        .expect("status")
        .expect("node status");

    assert_eq!(
        status
            .stages
            .iter()
            .map(|stage| (stage.id.as_str(), stage.importance.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("voice.transcribe", "required"),
            ("voice.summarize", "optional"),
            ("content.index", "required")
        ]
    );
}

#[test]
fn optional_stage_failure_produces_partial_when_required_work_succeeded() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let notes_dir = dir.path().join("notes");
    std::fs::create_dir_all(&notes_dir).expect("notes dir");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_voice_note(
        &mut conn,
        &CreateVoiceNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("voice note");
    let node_id = created.voice_note.note_id;

    update_stage(
        &conn,
        &node_id,
        "voice.transcribe",
        &StageUpdate::succeeded("Transcript completed"),
    )
    .expect("transcribe update");
    update_stage(
        &conn,
        &node_id,
        "content.index",
        &StageUpdate::succeeded("Indexed"),
    )
    .expect("index update");
    update_stage(
        &conn,
        &node_id,
        "voice.summarize",
        &StageUpdate::failed("Provider unavailable", true),
    )
    .expect("summary update");

    let status = get_node_status(&conn, &node_id)
        .expect("status")
        .expect("node status");
    assert_eq!(status.overall, "partial");
    assert_eq!(status.primary_stage_id.as_deref(), Some("voice.summarize"));
}

#[test]
fn required_stage_failure_produces_failed() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: None,
        },
    )
    .expect("url");

    update_stage(
        &conn,
        &created.node_id,
        "url.crawl",
        &StageUpdate::failed("HTTP 500", true),
    )
    .expect("crawl failure");

    let status = get_node_status(&conn, &created.node_id)
        .expect("status")
        .expect("node status");
    assert_eq!(status.overall, "failed");
    assert_eq!(status.primary_stage_id.as_deref(), Some("url.crawl"));
    assert_eq!(
        status.stages[0].error.as_ref().map(|error| error.retryable),
        Some(true)
    );
}

#[test]
fn snapshot_contains_revision_and_all_nodes() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: None,
        },
    )
    .expect("url");
    conn.execute(
        "INSERT INTO nodes (id, kind, name, state, size_bytes) VALUES (?1, 'file', ?2, 'ready', 0)",
        params!["image-1", "receipt.png"],
    )
    .expect("file node");

    let snapshot = get_node_status_snapshot(&conn).expect("snapshot");

    assert!(snapshot.revision > 0);
    assert!(snapshot.nodes.contains_key(&created.node_id));
    let image_status = snapshot.nodes.get("image-1").expect("image status");
    assert_eq!(
        image_status
            .stages
            .iter()
            .map(|stage| stage.id.as_str())
            .collect::<Vec<_>>(),
        vec!["content.index", "image.enhance"]
    );
}

#[test]
fn running_stage_becomes_primary_even_when_required_stage_failed() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: None,
        },
    )
    .expect("url");

    update_stage(
        &conn,
        &created.node_id,
        "content.index",
        &StageUpdate::failed("Embedding failed", true),
    )
    .expect("index failure");
    update_stage(
        &conn,
        &created.node_id,
        "url.crawl",
        &StageUpdate::running("Retrying crawl"),
    )
    .expect("crawl running");

    let status = get_node_status(&conn, &created.node_id)
        .expect("status")
        .expect("node status");
    assert_eq!(status.overall, "running");
    assert_eq!(status.primary_stage_id.as_deref(), Some("url.crawl"));
}

#[test]
fn stage_detail_survives_after_finished_stage() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("cognios.db");
    let mut conn = open_database(&db_path).expect("database");
    let created = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: None,
        },
    )
    .expect("url");

    update_stage(
        &conn,
        &created.node_id,
        "url.crawl",
        &StageUpdate {
            state: StageState::Succeeded,
            message: Some("Crawl succeeded".into()),
            detail: Some(serde_json::json!({"title": "Example"})),
            error_message: None,
            retryable: false,
            attempt: Some(2),
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".into()),
        },
    )
    .expect("crawl update");

    let status = get_node_status(&conn, &created.node_id)
        .expect("status")
        .expect("node status");
    let crawl = status
        .stages
        .iter()
        .find(|stage| stage.id == "url.crawl")
        .expect("crawl stage");
    assert_eq!(
        crawl.detail.as_ref().and_then(|v| v.get("title")).unwrap(),
        "Example"
    );
    assert_eq!(crawl.attempt, 2);
}
