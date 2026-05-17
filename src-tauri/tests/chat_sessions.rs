use tempfile::tempdir;

use cognios_lib::infrastructure::db::chat_repository::{
    append_message, bind_note, create_session, get_session_detail, list_sessions, record_cluster,
    update_session_title, AppendChatMessageInput, BindChatNoteInput, CreateChatSessionInput,
    RecordChatClusterInput, UpdateChatSessionTitleInput,
};
use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::services::notes::create_note::{create_note, CreateNoteInput};

#[test]
fn persists_chat_session_messages_clusters_and_bound_note() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let notes_dir = tempdir.path().join("notes");
    std::fs::create_dir_all(&notes_dir).expect("notes dir");

    let (session_id, note_id) = {
        let mut conn = open_database(&db_path).expect("database");
        let session = create_session(
            &conn,
            &CreateChatSessionInput {
                title: Some("Accident timeline".into()),
            },
        )
        .expect("session");
        let user = append_message(
            &conn,
            &AppendChatMessageInput {
                session_id: session.id.clone(),
                role: "user".into(),
                body: "整理事故时间线".into(),
                metadata_json: None,
            },
        )
        .expect("user message");
        let assistant = append_message(
            &conn,
            &AppendChatMessageInput {
                session_id: session.id.clone(),
                role: "assistant".into(),
                body: "先确认资料簇。".into(),
                metadata_json: Some(r#"{"stage":"clustering"}"#.into()),
            },
        )
        .expect("assistant message");
        assert_eq!(user.ordinal, 0);
        assert_eq!(assistant.ordinal, 1);

        record_cluster(
            &conn,
            &RecordChatClusterInput {
                session_id: session.id.clone(),
                turn_message_id: Some(assistant.id),
                title: "事故照片文件夹".into(),
                source_kind: "workspace".into(),
                status: "candidate".into(),
                summary: "同一挂载目录下的照片和 PDF。".into(),
                score: 0.91,
                sources_json: Some(r#"[{"nodeId":"n1","path":"事故/照片"}]"#.into()),
            },
        )
        .expect("cluster");

        let note = create_note(
            &mut conn,
            &CreateNoteInput { parent_id: None },
            &notes_dir,
            &|_| {},
        )
        .expect("note");
        bind_note(
            &conn,
            &BindChatNoteInput {
                session_id: session.id.clone(),
                note_id: note.node_id.clone(),
            },
        )
        .expect("bind note");

        (session.id, note.node_id)
    };

    let reopened = open_database(&db_path).expect("database reopen");
    let detail = get_session_detail(&reopened, &session_id)
        .expect("detail query")
        .expect("detail exists");

    assert_eq!(detail.session.title, "Accident timeline");
    assert_eq!(
        detail.session.bound_note_id.as_deref(),
        Some(note_id.as_str())
    );
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[0].role, "user");
    assert_eq!(
        detail.messages[1].metadata_json,
        r#"{"stage":"clustering"}"#
    );
    assert_eq!(detail.clusters.len(), 1);
    assert_eq!(detail.clusters[0].source_kind, "workspace");
    assert_eq!(detail.clusters[0].status, "candidate");
    assert!(detail.memory.is_none());
}

#[test]
fn opening_session_history_does_not_enqueue_external_work() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");

    let detail = get_session_detail(&conn, &session.id)
        .expect("detail query")
        .expect("detail exists");

    assert!(detail.messages.is_empty());
    assert!(detail.clusters.is_empty());
    assert!(list_sessions(&conn).expect("sessions").len() == 1);
}

#[test]
fn updates_chat_session_title_after_first_prompt() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database");
    let session = create_session(&conn, &CreateChatSessionInput { title: None }).expect("session");

    let updated = update_session_title(
        &conn,
        &UpdateChatSessionTitleInput {
            session_id: session.id.clone(),
            title: "整理事故时间线".into(),
        },
    )
    .expect("title update");

    assert_eq!(updated.title, "整理事故时间线");
    assert_eq!(
        get_session_detail(&conn, &session.id)
            .expect("detail query")
            .expect("detail exists")
            .session
            .title,
        "整理事故时间线"
    );
}

#[test]
fn chat_migration_preserves_existing_workspace_rows() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    {
        let conn = rusqlite::Connection::open(&db_path).expect("raw database");
        conn.execute_batch(
            "
            PRAGMA user_version = 4;
            CREATE TABLE nodes (
              id TEXT PRIMARY KEY,
              parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              state TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              mount_id TEXT,
              relative_path TEXT,
              size_bytes INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE url_jobs (
              node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
              url TEXT NOT NULL,
              title TEXT,
              description TEXT,
              preview_text TEXT,
              canonical_url TEXT,
              html_cache_path TEXT,
              last_error TEXT
            );
            INSERT INTO nodes (id, kind, name, state) VALUES ('n1', 'note', 'Existing', 'ready');
            INSERT INTO url_jobs (node_id, url) VALUES ('n1', 'https://example.test');
            ",
        )
        .expect("seed v4 database");
    }

    let conn = open_database(&db_path).expect("migrated database");
    let name: String = conn
        .query_row("SELECT name FROM nodes WHERE id = 'n1'", [], |row| {
            row.get(0)
        })
        .expect("existing node");
    let url: String = conn
        .query_row("SELECT url FROM url_jobs WHERE node_id = 'n1'", [], |row| {
            row.get(0)
        })
        .expect("existing url job");
    let user_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");

    assert_eq!(name, "Existing");
    assert_eq!(url, "https://example.test");
    let memory_table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'chat_session_memories'",
            [],
            |row| row.get(0),
        )
        .expect("memory table");

    assert_eq!(memory_table_count, 1);
    assert_eq!(user_version, 8);
}
