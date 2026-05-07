// Unit 1 — VFS event-emission gap closure.
//
// Asserts that every node mutation that affects search-relevant content
// fires exactly one vfs://changed event with the right reason verb on
// success, and zero events on failure. This is the prerequisite that
// allows the future search sidecar to subscribe to mutations without
// silently missing changes.
//
// The misnamed `mount_id` field of VfsChangeEvent carries the affected
// node id for note/folder events (matching the existing url-job pattern
// where the same field carries the url node id). A plan-level rename of
// that field is a v2 follow-up; this unit only widens the producer set.

use std::fs;
use std::sync::{Arc, Mutex};

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::node_repository::{create_folder, CreateFolderInput};
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::mutations::rename_node::{rename_node, RenameNodeInput};
use cognios_lib::services::notes::create_note::{create_note, CreateNoteInput};
use cognios_lib::services::notes::save_note_content::save_note_content;

type EventLog = Arc<Mutex<Vec<VfsChangeEvent>>>;

fn capturing_emitter() -> (EventLog, impl Fn(VfsChangeEvent)) {
    let events: EventLog = Arc::new(Mutex::new(Vec::new()));
    let events_for_closure = Arc::clone(&events);
    let emitter = move |event: VfsChangeEvent| {
        events_for_closure
            .lock()
            .expect("event log lock not poisoned")
            .push(event);
    };
    (events, emitter)
}

fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let app_dir = tempdir().expect("app tempdir");
    let db_path = app_dir.path().join("cognios.db");
    let notes_dir = app_dir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    (app_dir, db_path, notes_dir)
}

#[test]
fn create_note_fires_node_created_event() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &emitter,
    )
    .expect("create note");

    let log = events.lock().expect("log");
    assert_eq!(log.len(), 1, "exactly one event");
    assert_eq!(log[0].reason, "node-created");
    assert_eq!(log[0].mount_id, created.node_id);
}

#[test]
fn save_note_content_fires_node_saved_event() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &emitter,
    )
    .expect("create note");

    save_note_content(&conn, &created.node_id, "hello world", &notes_dir, &emitter)
        .expect("save note");

    let log = events.lock().expect("log");
    assert_eq!(log.len(), 2, "create + save");
    assert_eq!(log[0].reason, "node-created");
    assert_eq!(log[1].reason, "node-saved");
    assert_eq!(log[1].mount_id, created.node_id);
}

#[test]
fn delete_node_fires_node_deleted_event_with_target_id() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &emitter,
    )
    .expect("create note");

    delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: created.node_id.clone(),
            cascade: None,
        },
        &notes_dir,
        &emitter,
    )
    .expect("delete note");

    let log = events.lock().expect("log");
    assert_eq!(log.len(), 2, "create + delete");
    assert_eq!(log[1].reason, "node-deleted");
    assert_eq!(log[1].mount_id, created.node_id);
}

#[test]
fn rename_node_fires_node_renamed_event_with_target_id() {
    let (_app_dir, db_path, _notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let created = create_folder(
        &conn,
        &CreateFolderInput {
            name: "Inbox".into(),
            parent_id: None,
        },
    )
    .expect("create folder");

    rename_node(
        &mut conn,
        &RenameNodeInput {
            node_id: created.node_id.clone(),
            new_name: "Outbox".into(),
        },
        &emitter,
    )
    .expect("rename folder");

    let log = events.lock().expect("log");
    assert_eq!(
        log.len(),
        1,
        "rename only — create_folder is repository-level"
    );
    assert_eq!(log[0].reason, "node-renamed");
    assert_eq!(log[0].mount_id, created.node_id);
}

#[test]
fn failed_mutation_fires_zero_events() {
    let (_app_dir, db_path, _notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    // Empty new name is rejected before any persistence happens.
    let error = rename_node(
        &mut conn,
        &RenameNodeInput {
            node_id: "any-id".into(),
            new_name: "   ".into(),
        },
        &emitter,
    )
    .expect_err("blank name rejected");
    assert!(error.contains("must not be empty"));

    let log = events.lock().expect("log");
    assert_eq!(log.len(), 0, "no events on failure");
}

#[test]
fn delete_folder_with_cascade_carries_descendant_ids_in_event() {
    // Regression: deleting a Mount or Folder used to forward only
    // the parent's id to the sidecar — but ON DELETE CASCADE
    // silently nuked the children sqlite-side, leaving their
    // lancedb chunks orphaned. The event now carries every
    // descendant id so the forwarder can fan out a delete per row.
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    // Build: parent folder → child folder → leaf note.
    let parent = create_folder(
        &conn,
        &CreateFolderInput {
            name: "parent".into(),
            parent_id: None,
        },
    )
    .expect("create parent");
    let child = create_folder(
        &conn,
        &CreateFolderInput {
            name: "child".into(),
            parent_id: Some(parent.node_id.clone()),
        },
    )
    .expect("create child");
    let note = create_note(
        &mut conn,
        &CreateNoteInput {
            parent_id: Some(child.node_id.clone()),
        },
        &notes_dir,
        &emitter,
    )
    .expect("create note");

    // Cascade delete the parent.
    delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: parent.node_id.clone(),
            cascade: Some(true),
        },
        &notes_dir,
        &emitter,
    )
    .expect("delete parent with cascade");

    let log = events.lock().expect("log");
    let last = log.last().expect("at least one event");
    assert_eq!(last.reason, "node-deleted");
    assert_eq!(last.mount_id, parent.node_id);

    // The descendant_ids list must include the child folder + the
    // note (every row sqlite cascaded out), but not the parent
    // itself (the parent id rides in `mount_id`).
    let descendants: std::collections::HashSet<&String> = last.descendant_ids.iter().collect();
    assert!(
        descendants.contains(&child.node_id),
        "child folder id missing from descendant_ids: {:?}",
        last.descendant_ids
    );
    assert!(
        descendants.contains(&note.node_id),
        "note id missing from descendant_ids: {:?}",
        last.descendant_ids
    );
    assert!(
        !descendants.contains(&parent.node_id),
        "parent id leaked into descendant_ids"
    );
}

#[test]
fn delete_leaf_note_emits_no_descendant_ids() {
    // Sanity check: leaf nodes carry an empty descendant list so
    // the forwarder's batch path is a no-op for the common case.
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let created = create_note(
        &mut conn,
        &CreateNoteInput { parent_id: None },
        &notes_dir,
        &emitter,
    )
    .expect("create note");

    delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: created.node_id.clone(),
            cascade: None,
        },
        &notes_dir,
        &emitter,
    )
    .expect("delete leaf note");

    let log = events.lock().expect("log");
    let last = log.last().expect("at least one event");
    assert_eq!(last.reason, "node-deleted");
    assert!(
        last.descendant_ids.is_empty(),
        "leaf delete should not carry descendants: {:?}",
        last.descendant_ids
    );
}

#[test]
fn delete_unknown_node_fires_zero_events() {
    let (_app_dir, db_path, notes_dir) = setup();
    let mut conn = open_database(&db_path).expect("database");
    let (events, emitter) = capturing_emitter();

    let error = delete_node(
        &mut conn,
        &DeleteNodeInput {
            node_id: "does-not-exist".into(),
            cascade: None,
        },
        &notes_dir,
        &emitter,
    )
    .expect_err("missing node rejected");
    assert!(error.contains("not found"));

    let log = events.lock().expect("log");
    assert_eq!(log.len(), 0, "no events on failure");
}
