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
    IndexStatusDto, LicenseAcceptResponseDto, ModelDownloadEvent, ModelsStatusDto,
    NodeIndexStatusDto, SearchInput, SearchResponseDto, SidecarEnvelope,
};
use crate::services::secure_storage;
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
pub struct AcceptModelLicenseInput {
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartModelDownloadInput {
    pub role: String,
    #[serde(default)]
    pub hf_token: Option<String>,
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
pub async fn get_indexing_status(
    state: State<'_, AppState>,
) -> EnvelopeResult<IndexStatusDto> {
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
pub async fn get_models_status(
    state: State<'_, AppState>,
) -> EnvelopeResult<ModelsStatusDto> {
    Ok(state.search_client.models_status().await)
}

#[tauri::command]
pub async fn accept_model_license(
    state: State<'_, AppState>,
    input: AcceptModelLicenseInput,
) -> EnvelopeResult<LicenseAcceptResponseDto> {
    Ok(state.search_client.accept_model_license(&input.role).await)
}

#[tauri::command]
pub async fn start_model_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: StartModelDownloadInput,
) -> Result<(), String> {
    // If the caller didn't supply an explicit token, fall back to the
    // one stashed in the OS keychain (set via the LicenseAcceptanceModal
    // for gated repos like Gemma). Renderer never sees the value —
    // only a presence flag via `has_hf_token`.
    let resolved_token = match input.hf_token {
        Some(t) => Some(t),
        None => secure_storage::get_secret(secure_storage::HF_TOKEN_ACCOUNT)
            .unwrap_or(None),
    };

    let app = app.clone();
    state
        .search_client
        .start_model_download(
            &input.role,
            resolved_token.as_deref(),
            move |event: ModelDownloadEvent| {
                if let Err(err) = app.emit(MODELS_PROGRESS_EVENT, event) {
                    log::warn!(
                        "failed to emit {MODELS_PROGRESS_EVENT}: {err}"
                    );
                }
            },
        )
        .await
}

// Re-export the envelope type so a consumer of `commands::search`
// (e.g. an integration test) can refer to it without crossing the
// services boundary.
#[allow(dead_code)]
pub type Envelope<T> = SidecarEnvelope<T>;
