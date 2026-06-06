use serde::Deserialize;
use tauri::State;

use crate::domain::node_status::{NodeStatusSnapshotDto, NodeStatusViewDto};
use crate::infrastructure::db::node_status_repository::{
    get_node_status as load_node_status, get_node_status_snapshot as load_node_status_snapshot,
};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNodeStatusInput {
    pub node_id: String,
}

#[tauri::command]
pub fn get_node_status_snapshot(
    state: State<'_, AppState>,
) -> Result<NodeStatusSnapshotDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    load_node_status_snapshot(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_node_status(
    state: State<'_, AppState>,
    input: GetNodeStatusInput,
) -> Result<NodeStatusViewDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    load_node_status(&conn, &input.node_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("node not found: {}", input.node_id))
}
