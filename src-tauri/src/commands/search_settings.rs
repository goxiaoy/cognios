//! Tauri commands for the persisted search settings + sidecar restart.
//!
//! Three commands:
//!
//! - ``get_search_settings`` — proxies ``GET /settings`` from the
//!   sidecar.
//! - ``update_search_settings`` — proxies ``PUT /settings``; the
//!   sidecar persists, validates against the schema, and recomputes
//!   the ``needs_restart`` flag.
//! - ``restart_sidecar`` — graceful supervisor cycle (SIGTERM with
//!   grace, fall back to SIGKILL, wait for runtime file to come back
//!   up). Used by the UI's "Restart sidecar to apply" button.
//!
//! The fallback read path (``services::search::read_settings_file_fallback``)
//! is exposed for the UI's degraded-mode flow but not wired through
//! these commands — the frontend can call it via a separate
//! ``read_search_settings_fallback`` command if/when needed.

use tauri::{AppHandle, State};

use crate::services::search::{read_settings_file_fallback, SearchSettingsDto, SidecarEnvelope};
use crate::AppState;

type EnvelopeResult<T> = Result<SidecarEnvelope<T>, String>;

#[tauri::command]
pub async fn get_search_settings(state: State<'_, AppState>) -> EnvelopeResult<SearchSettingsDto> {
    Ok(state.search_client.settings_get().await)
}

#[tauri::command]
pub async fn update_search_settings(
    state: State<'_, AppState>,
    settings: SearchSettingsDto,
) -> EnvelopeResult<SearchSettingsDto> {
    Ok(state.search_client.settings_put(&settings).await)
}

/// Read settings.json directly without the sidecar — used by the UI
/// when ``get_search_settings`` returns Unavailable but the user
/// still needs to see what's configured.
#[tauri::command]
pub fn read_search_settings_fallback(
    state: State<'_, AppState>,
) -> Result<SearchSettingsDto, String> {
    let path = state.storage_dir.join("search").join("settings.json");
    read_settings_file_fallback(&path)
}

#[tauri::command]
pub fn restart_sidecar(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.search_sidecar.restart(&app)?;
    Ok(())
}
