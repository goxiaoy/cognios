use serde::Deserialize;
use tauri::State;

use crate::infrastructure::db::connection::open_database;
use crate::services::files::read_file_content::read_file_content as read_file_content_record;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileContentInput {
    pub node_id: String,
}

#[tauri::command]
pub fn read_file_content(
    state: State<'_, AppState>,
    input: ReadFileContentInput,
) -> Result<String, String> {
    let conn = open_database(&state.db_path).map_err(|_| "file unavailable".to_string())?;
    read_file_content_record(&conn, &input.node_id)
}
