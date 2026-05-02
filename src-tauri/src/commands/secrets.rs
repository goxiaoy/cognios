//! Tauri commands wrapping `services::secure_storage`.
//!
//! These are the only IPC entry points that touch the OS keychain;
//! the search subsystem reads HF tokens via the same internal API,
//! never via these commands. Keeping a single audited boundary
//! prevents misuse from elsewhere in the app.

use serde::Deserialize;

use crate::services::secure_storage;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetHfTokenInput {
    pub token: String,
}

#[tauri::command]
pub fn set_hf_token(input: SetHfTokenInput) -> Result<(), String> {
    let trimmed = input.token.trim();
    if trimmed.is_empty() {
        return Err("HF token must not be empty".into());
    }
    secure_storage::set_secret(secure_storage::HF_TOKEN_ACCOUNT, trimmed)
}

#[tauri::command]
pub fn has_hf_token() -> Result<bool, String> {
    // Boolean rather than the raw secret — the renderer never sees
    // the actual token, only a presence flag for UI gating.
    secure_storage::get_secret(secure_storage::HF_TOKEN_ACCOUNT)
        .map(|v| v.is_some())
}

#[tauri::command]
pub fn delete_hf_token() -> Result<(), String> {
    secure_storage::delete_secret(secure_storage::HF_TOKEN_ACCOUNT)
}
