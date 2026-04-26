use serde::Deserialize;
use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::connection::open_database;
use crate::services::notes::create_note::{create_note as create_note_record, CreateNoteInput};
use crate::services::notes::get_note_content::get_note_content as get_note_content_record;
use crate::services::notes::save_note_content::save_note_content as save_note_content_record;
use crate::AppState;

#[tauri::command]
pub fn create_note(
    state: State<'_, AppState>,
    input: CreateNoteInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn =
        open_database(&state.db_path).map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let created = create_note_record(&mut conn, &input, &notes_dir, &emitter)?;
    Ok(created.snapshot)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNoteContentInput {
    pub note_id: String,
}

#[tauri::command]
pub fn get_note_content(
    state: State<'_, AppState>,
    input: GetNoteContentInput,
) -> Result<String, String> {
    let notes_dir = state.storage_dir.join("notes");
    get_note_content_record(&input.note_id, &notes_dir)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteContentInput {
    pub note_id: String,
    pub body: String,
}

#[tauri::command]
pub fn save_note_content(
    state: State<'_, AppState>,
    input: SaveNoteContentInput,
) -> Result<(), String> {
    let conn =
        open_database(&state.db_path).map_err(|error: rusqlite::Error| error.to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    save_note_content_record(&conn, &input.note_id, &input.body, &notes_dir, &emitter)
}
