use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::node_repository::create_folder;
use cognios_lib::infrastructure::db::node_repository::CreateFolderInput;
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::notes::create_note::{create_note, CreateNoteInput};
use cognios_lib::services::notes::get_note_content::get_note_content;
use cognios_lib::services::notes::save_note_content::save_note_content;

fn noop_emitter(_event: VfsChangeEvent) {}

fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let app_dir = tempdir().expect("app tempdir");
    let db_path = app_dir.path().join("cognios.db");
    let notes_dir = app_dir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    (app_dir, db_path, notes_dir)
}

#[test]
fn create_note_inserts_node_and_creates_empty_md_file() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note");

    assert_eq!(created.snapshot.roots.len(), 1);
    let note = &created.snapshot.roots[0];
    assert_eq!(note.kind, "note");
    assert_eq!(note.name, "Untitled");
    assert_eq!(note.id, created.node_id);

    let note_path = notes_dir.join(format!("{}.md", note.id));
    assert!(note_path.exists(), ".md file should be created on disk");
    assert_eq!(
        fs::read_to_string(&note_path).expect("read md file"),
        "",
        ".md file should be empty initially"
    );
}

#[test]
fn create_note_appears_as_child_of_folder() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let folder_created = create_folder(
        &conn,
        &CreateFolderInput {
            name: "Notes Folder".into(),
            parent_id: None,
        },
    )
    .expect("folder");
    let folder_id = folder_created.snapshot.roots[0].id.clone();

    let created = create_note(
        &mut conn,
        &CreateNoteInput {
            parent_id: Some(folder_id.clone()),
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note in folder");

    let folder = created
        .snapshot
        .roots
        .iter()
        .find(|n| n.id == folder_id)
        .expect("folder in snapshot");
    assert_eq!(folder.children.len(), 1);
    assert_eq!(folder.children[0].kind, "note");
}

#[test]
fn get_note_content_returns_empty_string_when_file_missing() {
    let (_app_dir, _db_path, notes_dir) = setup();

    let content = get_note_content("nonexistent-id", &notes_dir).expect("get content");
    assert_eq!(content, "");
}

#[test]
fn save_and_retrieve_note_content() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note");
    let note_id = created.node_id;

    let body = "# Hello\n\nThis is a note.";
    save_note_content(&conn, &note_id, body, &notes_dir, &noop_emitter).expect("save content");

    let retrieved = get_note_content(&note_id, &notes_dir).expect("get content");
    assert_eq!(retrieved, body);
}

#[test]
fn save_note_content_updates_size_bytes_in_db() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note");
    let note_id = created.node_id;

    let body = "Hello, notes!";
    save_note_content(&conn, &note_id, body, &notes_dir, &noop_emitter).expect("save");

    let size_bytes: i64 = conn
        .query_row(
            "SELECT size_bytes FROM nodes WHERE id = ?1",
            [&note_id],
            |row| row.get(0),
        )
        .expect("size_bytes query");
    assert_eq!(size_bytes, body.len() as i64);
}

#[test]
fn delete_note_removes_md_file_and_db_record() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note");
    let note_id = created.node_id;

    save_note_content(&conn, &note_id, "some content", &notes_dir, &noop_emitter).expect("save");

    let note_path = notes_dir.join(format!("{note_id}.md"));
    assert!(note_path.exists(), "file exists before delete");

    let after_snapshot = delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: note_id.clone(),
            cascade: None,
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("delete note");

    assert!(
        !after_snapshot.roots.iter().any(|n| n.id == note_id),
        "note removed from snapshot"
    );
    assert!(!note_path.exists(), ".md file removed from disk");
}

#[test]
fn delete_note_succeeds_when_md_file_already_missing() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &noop_emitter,
    )
    .expect("create note");
    let note_id = created.node_id;

    // Remove the file manually before deletion.
    let note_path = notes_dir.join(format!("{note_id}.md"));
    fs::remove_file(&note_path).expect("manual remove");

    let after_snapshot = delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: note_id.clone(),
            cascade: None,
        },
        &notes_dir,
        &noop_emitter,
    )
    .expect("delete note with missing file");

    assert!(
        !after_snapshot.roots.iter().any(|n| n.id == note_id),
        "note removed from snapshot even though file was already gone"
    );
}
