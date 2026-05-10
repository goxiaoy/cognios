use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::chat_repository::{
    create_session, get_session_detail, CreateChatSessionInput,
};
use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::services::chat::live_note::update_live_note;
use cognios_lib::services::mounts::watcher::VfsChangeEvent;

fn noop_emitter(_event: VfsChangeEvent) {}

#[test]
fn first_answer_creates_and_binds_one_live_note() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let notes_dir = tempdir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    let mut conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");

    let first_note = update_live_note(
        &mut conn,
        &session.id,
        "事故发生在 3 月 1 日。",
        &[serde_json::json!({
            "sourceKind": "workspace",
            "title": "事故照片",
            "citation": "n1"
        })],
        &notes_dir,
        &noop_emitter,
    )
    .expect("first note update");
    let second_note = update_live_note(
        &mut conn,
        &session.id,
        "补充费用：维修 1200。",
        &[],
        &notes_dir,
        &noop_emitter,
    )
    .expect("second note update");

    assert_eq!(first_note, second_note);
    let detail = get_session_detail(&conn, &session.id)
        .expect("detail query")
        .expect("detail");
    assert_eq!(
        detail.session.bound_note_id.as_deref(),
        Some(first_note.as_str())
    );
    let body = fs::read_to_string(notes_dir.join(format!("{first_note}.md"))).expect("note body");
    assert!(body.contains("补充费用"));
    assert!(!body.contains("事故发生在 3 月 1 日。"));
}

#[test]
fn live_note_rejects_missing_session() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let notes_dir = tempdir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    let mut conn = open_database(&db_path).expect("database");

    let error = update_live_note(
        &mut conn,
        "missing",
        "answer",
        &[],
        &notes_dir,
        &noop_emitter,
    )
    .expect_err("missing session rejected");

    assert!(error.contains("chat session does not exist"));
}
