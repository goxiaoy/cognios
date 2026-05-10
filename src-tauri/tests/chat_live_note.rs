use tempfile::tempdir;

use cognios_lib::infrastructure::db::chat_repository::{
    append_message, create_session, get_session_detail, AppendChatMessageInput,
    CreateChatSessionInput,
};
use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::services::chat::session_memory::{
    begin_refresh, complete_refresh, delete_session_memory, memory_root,
    pending_refresh_session_ids, read_verified_body, record_successful_turn,
    recover_orphaned_refreshes,
};

#[test]
fn first_refresh_creates_file_backed_memory_without_note_binding() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");

    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "user".into(),
            body: "整理事故时间线".into(),
            metadata_json: None,
        },
    )
    .expect("user message");
    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "assistant".into(),
            body: "事故发生在 3 月 1 日。".into(),
            metadata_json: None,
        },
    )
    .expect("assistant message");

    let should_refresh = record_successful_turn(
        &conn,
        &session.id,
        Some("local-ollama"),
        Some("qwen2.5:7b"),
        64,
    )
    .expect("dirty memory");
    assert!(should_refresh);

    let root = memory_root(tempdir.path());
    let job = begin_refresh(&conn, &root, &session.id)
        .expect("begin refresh")
        .expect("job");
    assert_eq!(job.messages.len(), 2);
    complete_refresh(
        &conn,
        &root,
        &job,
        "## Timeline\n\n- 3 月 1 日：事故发生",
        job.last_message_ordinal,
        Some("local-ollama"),
        Some("qwen2.5:7b"),
    )
    .expect("complete refresh");

    let memory = read_verified_body(&conn, &root, &session.id)
        .expect("read memory")
        .expect("memory body");
    assert!(memory.body.contains("3 月 1 日"));

    let detail = get_session_detail(&conn, &session.id)
        .expect("detail query")
        .expect("detail");
    assert_eq!(detail.session.bound_note_id, None);
    assert!(detail.memory.expect("memory metadata").available);

    let visible_notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))
        .expect("node count");
    assert_eq!(visible_notes, 0);
}

#[test]
fn session_memory_rejects_missing_session() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");

    let error = record_successful_turn(&conn, "missing", None, None, 10)
        .expect_err("missing session rejected");

    assert!(error.contains("chat session does not exist"));
}

#[test]
fn deleting_session_memory_removes_internal_file_without_visible_note_effects() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");
    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "assistant".into(),
            body: "费用 1200 元。".into(),
            metadata_json: None,
        },
    )
    .expect("assistant message");
    record_successful_turn(&conn, &session.id, None, None, 16).expect("dirty memory");

    let root = memory_root(tempdir.path());
    let job = begin_refresh(&conn, &root, &session.id)
        .expect("begin refresh")
        .expect("job");
    complete_refresh(
        &conn,
        &root,
        &job,
        "## Cost\n\n- 维修：1200 元",
        job.last_message_ordinal,
        None,
        None,
    )
    .expect("complete refresh");
    assert!(root.join(&session.id).exists());

    delete_session_memory(&conn, &root, &session.id).expect("delete memory");

    assert!(!root.join(&session.id).exists());
    assert!(read_verified_body(&conn, &root, &session.id)
        .expect("read after delete")
        .is_none());
}

#[test]
fn dirty_turns_during_refresh_are_preserved_for_follow_up_compaction() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");
    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "assistant".into(),
            body: "第一次总结。".into(),
            metadata_json: None,
        },
    )
    .expect("first assistant message");
    record_successful_turn(&conn, &session.id, None, None, 16).expect("dirty memory");

    let root = memory_root(tempdir.path());
    let first_job = begin_refresh(&conn, &root, &session.id)
        .expect("begin first refresh")
        .expect("first job");

    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "assistant".into(),
            body: "第二次总结。".into(),
            metadata_json: None,
        },
    )
    .expect("second assistant message");
    let should_parallel_refresh =
        record_successful_turn(&conn, &session.id, None, None, 16).expect("coalesced dirty memory");
    assert!(!should_parallel_refresh);

    complete_refresh(
        &conn,
        &root,
        &first_job,
        "## Memory\n\n- 第一次总结。",
        first_job.last_message_ordinal,
        None,
        None,
    )
    .expect("complete first refresh");

    let follow_up = begin_refresh(&conn, &root, &session.id)
        .expect("begin follow-up refresh")
        .expect("follow-up job");
    assert_eq!(follow_up.messages.len(), 1);
    assert_eq!(follow_up.messages[0].content, "第二次总结。");
}

#[test]
fn startup_recovery_demotes_interrupted_running_refreshes_to_dirty() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");
    append_message(
        &conn,
        &AppendChatMessageInput {
            session_id: session.id.clone(),
            role: "assistant".into(),
            body: "第一次总结。".into(),
            metadata_json: None,
        },
    )
    .expect("assistant message");
    record_successful_turn(&conn, &session.id, None, None, 16).expect("dirty memory");

    let root = memory_root(tempdir.path());
    assert!(begin_refresh(&conn, &root, &session.id)
        .expect("begin refresh")
        .is_some());

    let recovered = recover_orphaned_refreshes(&conn).expect("recover interrupted refreshes");
    assert_eq!(recovered, 1);
    assert_eq!(
        pending_refresh_session_ids(&conn).expect("pending refresh ids"),
        vec![session.id.clone()]
    );

    let recovered_job = begin_refresh(&conn, &root, &session.id)
        .expect("begin recovered refresh")
        .expect("recovered job");
    assert_eq!(recovered_job.messages.len(), 1);
    assert_eq!(recovered_job.messages[0].content, "第一次总结。");
}
