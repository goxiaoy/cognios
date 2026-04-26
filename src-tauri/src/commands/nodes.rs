use rusqlite::OptionalExtension;
use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::connection::open_database;
use crate::services::mutations::delete_node::{delete_node as delete_node_record, DeleteNodeInput};
use crate::services::mutations::rename_node::{rename_node as rename_node_record, RenameNodeInput};
use crate::AppState;

#[tauri::command]
pub fn rename_node(
    state: State<'_, AppState>,
    input: RenameNodeInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn =
        open_database(&state.db_path).map_err(|error: rusqlite::Error| error.to_string())?;
    let emitter = state.emitter.as_ref();
    rename_node_record(&mut conn, &input, &emitter)
}

#[tauri::command]
pub fn delete_node(
    state: State<'_, AppState>,
    input: DeleteNodeInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn =
        open_database(&state.db_path).map_err(|error: rusqlite::Error| error.to_string())?;
    let mount_id = resolve_mount_id(&conn, &input.node_id)?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let snapshot = delete_node_record(&mut conn, &input, &notes_dir, &emitter)?;
    if let Some(mount_id) = mount_id {
        state.mount_watchers.stop_mount(&mount_id);
    }
    Ok(snapshot)
}

fn resolve_mount_id(conn: &rusqlite::Connection, node_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM nodes WHERE id = ?1 AND kind = 'mount'",
        [node_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error: rusqlite::Error| error.to_string())
}
