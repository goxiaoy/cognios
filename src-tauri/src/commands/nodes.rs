use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::url_repository::{retry_url as retry_url_record, RetryUrlInput};
use crate::services::mutations::delete_node::{delete_node as delete_node_record, DeleteNodeInput};
use crate::services::mutations::reindex_node::{
    reindex_node as reindex_node_record, ReindexNodeInput,
};
use crate::services::mutations::rename_node::{rename_node as rename_node_record, RenameNodeInput};
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexNodeResult {
    pub enqueued: usize,
}

#[tauri::command]
pub fn rename_node(
    state: State<'_, AppState>,
    input: RenameNodeInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let emitter = state.emitter.as_ref();
    rename_node_record(&mut conn, &input, &emitter)
}

#[tauri::command]
pub fn delete_node(
    state: State<'_, AppState>,
    input: DeleteNodeInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let mount_id = resolve_mount_id(&conn, &input.node_id)?;
    let notes_dir = state.storage_dir.join("notes");
    let emitter = state.emitter.as_ref();
    let snapshot = delete_node_record(&mut conn, &input, &notes_dir, &emitter)?;
    if let Some(mount_id) = mount_id {
        state.mount_watchers.stop_mount(&mount_id);
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn reindex_node(
    state: State<'_, AppState>,
    input: ReindexNodeInput,
) -> Result<ReindexNodeResult, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let emitter = state.emitter.as_ref();
    let outcome = reindex_node_record(&conn, &input, &emitter)?;
    for node_id in &outcome.url_recrawl_ids {
        retry_url_record(
            &conn,
            &RetryUrlInput {
                node_id: node_id.clone(),
            },
        )
        .map_err(|error| error.to_string())?;
        state.url_jobs.enqueue(node_id.clone())?;
    }
    Ok(ReindexNodeResult {
        enqueued: outcome.enqueued,
    })
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
