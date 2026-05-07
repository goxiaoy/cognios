//! Tauri-facing search commands. Thin wrappers over
//! [`crate::services::search::SearchSidecarClient`].
//!
//! Every command returns a typed [`SidecarEnvelope`] so the UI can
//! distinguish `ready | initialising | unavailable` without parsing
//! error strings. Genuine bugs (lock poisoning, JSON serialisation
//! failures) still surface as `Err(String)` for Tauri's default
//! error display.

use serde::Deserialize;
use tauri::{Emitter, State};

use crate::services::search::{
    IndexStatusDto, ModelDownloadEvent, ModelsStatusDto, NodeContentDto, NodeIndexStatusDto,
    SearchInput, SearchResponseDto, SidecarEnvelope,
};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryInput {
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNodeIndexingStatusInput {
    pub node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartModelDownloadInput {
    pub role: String,
}

/// Tauri event channel the frontend listens on for download progress.
/// One event per parsed SSE frame from the sidecar; frontends drive a
/// progress indicator by aggregating events keyed on ``role``.
pub const MODELS_PROGRESS_EVENT: &str = "models/progress";

// Wrap a `SidecarEnvelope` in a `Result::Ok` for the Tauri-command
// signature. The envelope already carries `state` and `error` fields,
// so genuine network or supervisor problems flow through as `Ok` with
// a non-`ready` state, not as `Err`.
type EnvelopeResult<T> = Result<SidecarEnvelope<T>, String>;

#[tauri::command]
pub async fn search_query(
    state: State<'_, AppState>,
    input: SearchQueryInput,
) -> EnvelopeResult<SearchResponseDto> {
    let body = SearchInput {
        query: input.query,
        limit: input.limit,
        sort: input.sort,
        cursor: input.cursor,
    };
    Ok(state.search_client.search(&body).await)
}

#[tauri::command]
pub async fn get_indexing_status(state: State<'_, AppState>) -> EnvelopeResult<IndexStatusDto> {
    Ok(state.search_client.index_status().await)
}

#[tauri::command]
pub async fn get_node_indexing_status(
    state: State<'_, AppState>,
    input: GetNodeIndexingStatusInput,
) -> EnvelopeResult<NodeIndexStatusDto> {
    Ok(state.search_client.node_index_status(&input.node_id).await)
}

#[tauri::command]
pub async fn get_node_content(
    state: State<'_, AppState>,
    input: GetNodeIndexingStatusInput,
) -> EnvelopeResult<NodeContentDto> {
    Ok(state.search_client.node_content(&input.node_id).await)
}

#[tauri::command]
pub async fn get_models_status(state: State<'_, AppState>) -> EnvelopeResult<ModelsStatusDto> {
    Ok(state.search_client.models_status().await)
}

#[tauri::command]
pub async fn start_model_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: StartModelDownloadInput,
) -> Result<(), String> {
    let app = app.clone();
    state
        .search_client
        .start_model_download(&input.role, move |event: ModelDownloadEvent| {
            if let Err(err) = app.emit(MODELS_PROGRESS_EVENT, event) {
                log::warn!("failed to emit {MODELS_PROGRESS_EVENT}: {err}");
            }
        })
        .await
}

// Re-export the envelope type so a consumer of `commands::search`
// (e.g. an integration test) can refer to it without crossing the
// services boundary.
#[allow(dead_code)]
pub type Envelope<T> = SidecarEnvelope<T>;
