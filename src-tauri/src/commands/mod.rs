pub mod files;
pub mod mounts;
pub mod nodes;
pub mod notes;
pub mod search;
pub mod search_settings;
pub mod secrets;
pub mod thumbnails;
pub mod urls;

use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::node_repository::{list_snapshot, CreateFolderInput};
use crate::services::mutations::create_folder::create_folder as create_folder_record;
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
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let emitter = state.emitter.as_ref();
    let created = create_folder_record(&mut conn, &input, &emitter)?;
    Ok(created.snapshot)
}
