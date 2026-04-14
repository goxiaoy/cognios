use std::fs;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Deserialize;
use uuid::Uuid;

use crate::domain::vfs::node::{ExplorerSnapshotDto, NodeKind};
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::node_repository::{list_snapshot, touch_node_modified_at};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    pub parent_id: Option<String>,
}

pub fn create_note(
    conn: &mut Connection,
    input: &CreateNoteInput,
    notes_dir: &Path,
) -> Result<ExplorerSnapshotDto, String> {
    let id = Uuid::new_v4().to_string();

    // Insert the node record first.
    conn.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ",
        params![
            id,
            input.parent_id,
            NodeKind::Note.as_str(),
            "Untitled",
            NodeState::Ready.as_str()
        ],
    )
    .map_err(|error| error.to_string())?;

    // Create the empty .md file on disk. If this fails, roll back the DB insert.
    let note_path = notes_dir.join(format!("{id}.md"));
    if let Err(file_error) = fs::write(&note_path, b"") {
        // Compensating rollback — remove the orphaned DB record.
        let _ = conn.execute("DELETE FROM nodes WHERE id = ?1", [&id]);
        return Err(format!("failed to create note file: {file_error}"));
    }

    touch_node_modified_at(conn, input.parent_id.as_deref())
        .map_err(|error| error.to_string())?;

    list_snapshot(conn).map_err(|error| error.to_string())
}
