use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::url_repository::{
    create_url as create_url_record, retry_url as retry_url_record, CreateUrlInput, RetryUrlInput,
};
use crate::AppState;

#[tauri::command]
pub fn create_url(
    state: State<'_, AppState>,
    input: CreateUrlInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let created_url = create_url_record(&mut conn, &input).map_err(|error| error.to_string())?;
    state.url_jobs.enqueue(created_url.node_id)?;
    Ok(created_url.snapshot)
}

#[tauri::command]
pub fn retry_url(state: State<'_, AppState>, input: RetryUrlInput) -> Result<(), String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    retry_url_record(&conn, &input).map_err(|error| error.to_string())?;
    state.url_jobs.enqueue(input.node_id)
}
