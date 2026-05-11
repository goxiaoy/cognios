use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Deserialize;
use uuid::Uuid;

use crate::domain::vfs::node::{ExplorerSnapshotDto, NodeKind};
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::node_repository::{list_snapshot, touch_node_modified_at};
use crate::services::mounts::watcher::VfsChangeEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    pub parent_id: Option<String>,
}

pub struct CreatedNote {
    pub node_id: String,
    pub snapshot: ExplorerSnapshotDto,
}

pub fn create_note(
    conn: &mut Connection,
    input: &CreateNoteInput,
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedNote, String> {
    create_note_with_body(conn, input, notes_dir, "", emitter)
}

pub fn create_note_with_body(
    conn: &mut Connection,
    input: &CreateNoteInput,
    notes_dir: &Path,
    body: &str,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedNote, String> {
    create_note_with_body_internal(conn, input, notes_dir, body, Some(emitter))
}

pub fn create_note_with_body_without_event(
    conn: &mut Connection,
    input: &CreateNoteInput,
    notes_dir: &Path,
    body: &str,
) -> Result<CreatedNote, String> {
    create_note_with_body_internal(conn, input, notes_dir, body, None)
}

fn create_note_with_body_internal(
    conn: &mut Connection,
    input: &CreateNoteInput,
    notes_dir: &Path,
    body: &str,
    emitter: Option<&dyn Fn(VfsChangeEvent)>,
) -> Result<CreatedNote, String> {
    let node_id = Uuid::new_v4().to_string();
    let size_bytes = body.len() as i64;

    conn.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ",
        params![
            node_id,
            input.parent_id,
            NodeKind::Note.as_str(),
            "Untitled",
            NodeState::Ready.as_str(),
            size_bytes
        ],
    )
    .map_err(|error| error.to_string())?;

    // Create the .md file before emitting VFS/index-visible events. If this
    // fails, roll back the DB insert so callers never see a partial Note.
    let note_path = notes_dir.join(format!("{node_id}.md"));
    if let Err(file_error) = fs::write(&note_path, body.as_bytes()) {
        let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&node_id]);
        return Err(format!("failed to create note file: {file_error}"));
    }

    touch_node_modified_at(conn, input.parent_id.as_deref()).map_err(|error| error.to_string())?;

    let snapshot = list_snapshot(conn).map_err(|error| error.to_string())?;
    if let Some(emitter) = emitter {
        emitter(VfsChangeEvent {
            mount_id: node_id.clone(),
            reason: "node-created".to_string(),
            ..Default::default()
        });
    }
    Ok(CreatedNote { node_id, snapshot })
}
