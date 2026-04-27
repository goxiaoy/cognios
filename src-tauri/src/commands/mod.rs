pub mod files;
pub mod mounts;
pub mod nodes;
pub mod notes;
pub mod thumbnails;
pub mod urls;

use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::node_repository::{
    create_folder as create_folder_record, list_snapshot, CreateFolderInput,
};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::AppState;

#[tauri::command]
pub fn get_explorer_snapshot(state: State<'_, AppState>) -> Result<ExplorerSnapshotDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_snapshot(&conn).map_err(|error: rusqlite::Error| error.to_string())
}

#[tauri::command]
pub fn create_folder(
    state: State<'_, AppState>,
    input: CreateFolderInput,
) -> Result<ExplorerSnapshotDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let created =
        create_folder_record(&conn, &input).map_err(|error: rusqlite::Error| error.to_string())?;
    (state.emitter)(VfsChangeEvent {
        mount_id: created.node_id,
        reason: "node-created".to_string(),
    });
    Ok(created.snapshot)
}
