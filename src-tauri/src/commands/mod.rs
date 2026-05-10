pub mod chat;
pub mod files;
pub mod mounts;
pub mod nodes;
pub mod notes;
pub mod search;
pub mod search_settings;
pub mod secrets;
pub mod thumbnails;
pub mod urls;

use std::sync::Arc;

use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::node_repository::{list_snapshot, CreateFolderInput};
use crate::services::mutations::create_folder::create_folder as create_folder_record;
use crate::services::search::client::{SearchSidecarClient, SidecarEnvelopeState};
use crate::services::search::index_state_sync::apply_index_changes;
use crate::AppState;

#[tauri::command]
pub async fn get_explorer_snapshot(
    state: State<'_, AppState>,
) -> Result<ExplorerSnapshotDto, String> {
    let db = state.db.clone();
    let search_client = Arc::clone(&state.search_client);
    refresh_index_state_from_sidecar(&db, &search_client).await;

    let conn = db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    list_snapshot(&conn).map_err(|error: rusqlite::Error| error.to_string())
}

const SNAPSHOT_INDEX_SYNC_LIMIT: u32 = 10_000;

async fn refresh_index_state_from_sidecar(db: &Database, client: &Arc<SearchSidecarClient>) {
    let mut cursor = 0_u64;
    loop {
        let env = client
            .index_changes(cursor, SNAPSHOT_INDEX_SYNC_LIMIT)
            .await;
        let changes = match env.state {
            SidecarEnvelopeState::Ready => match env.data {
                Some(data) => data,
                None => return,
            },
            SidecarEnvelopeState::Initialising | SidecarEnvelopeState::Unavailable => return,
        };
        if changes.transitions.is_empty() {
            return;
        }
        if let Err(error) = apply_index_changes(db, &changes.transitions) {
            log::warn!("explorer snapshot index-state refresh failed: {error}");
            return;
        }
        cursor = changes.next_seq.max(cursor);
        if changes.transitions.len() < SNAPSHOT_INDEX_SYNC_LIMIT as usize {
            return;
        }
    }
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
