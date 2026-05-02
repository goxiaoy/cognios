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

// ---- provider-scoped secrets -----------------------------------------------
//
// API keys for cloud providers (OpenAI, Qwen DashScope, ...) live under
// account names of the form ``provider:<id>`` so they share the
// ``cognios-search`` keychain group with the legacy ``hf-token`` slot
// without colliding. The Python sidecar reads from the same slot via
// the ``keyring`` library — see
// ``sidecar/search_sidecar/providers/keychain.py``.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderSecretInput {
    pub provider_id: String,
    pub secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretLookupInput {
    pub provider_id: String,
}

/// Validate a provider id at the IPC boundary so a malformed input
/// can't synthesize a weird keychain account name. Allowed shape
/// matches the PRESETS table on the sidecar side: lowercase letters,
/// digits, and hyphens, starting with a letter.
fn validate_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("provider_id must not be empty".into());
    }
    let mut chars = provider_id.chars();
    let first = chars.next().expect("non-empty");
    if !first.is_ascii_lowercase() {
        return Err("provider_id must start with a lowercase letter".into());
    }
    for c in chars {
        if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(
                "provider_id may only contain lowercase letters, digits, and hyphens"
                    .into(),
            );
        }
    }
    Ok(())
}

fn provider_account(provider_id: &str) -> String {
    format!("provider:{}", provider_id)
}

#[tauri::command]
pub fn set_provider_secret(input: SetProviderSecretInput) -> Result<(), String> {
    validate_provider_id(&input.provider_id)?;
    let trimmed = input.secret.trim();
    if trimmed.is_empty() {
        return Err("provider secret must not be empty".into());
    }
    secure_storage::set_secret(&provider_account(&input.provider_id), trimmed)
}

#[tauri::command]
pub fn get_provider_secret_present(
    input: ProviderSecretLookupInput,
) -> Result<bool, String> {
    validate_provider_id(&input.provider_id)?;
    secure_storage::get_secret(&provider_account(&input.provider_id))
        .map(|v| v.is_some())
}

#[tauri::command]
pub fn delete_provider_secret(
    input: ProviderSecretLookupInput,
) -> Result<(), String> {
    validate_provider_id(&input.provider_id)?;
    secure_storage::delete_secret(&provider_account(&input.provider_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_well_formed_ids() {
        validate_provider_id("openai").unwrap();
        validate_provider_id("qwen-dashscope").unwrap();
        validate_provider_id("local-gte").unwrap();
        validate_provider_id("a1-b2-c3").unwrap();
    }

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_provider_id("").is_err());
    }

    #[test]
    fn validate_rejects_uppercase() {
        assert!(validate_provider_id("OpenAI").is_err());
        assert!(validate_provider_id("OPENAI").is_err());
    }

    #[test]
    fn validate_rejects_leading_digit_or_hyphen() {
        assert!(validate_provider_id("1openai").is_err());
        assert!(validate_provider_id("-openai").is_err());
    }

    #[test]
    fn validate_rejects_special_chars() {
        assert!(validate_provider_id("openai/v1").is_err());
        assert!(validate_provider_id("openai key").is_err());
        assert!(validate_provider_id("provider:openai").is_err());
        assert!(validate_provider_id("openai_underscored").is_err());
    }

    #[test]
    fn provider_account_format_matches_sidecar_expectation() {
        // Must match ``provider:<id>`` so the sidecar's
        // keyring.get_password("cognios-search", f"provider:{id}")
        // hits the same slot.
        assert_eq!(provider_account("openai"), "provider:openai");
        assert_eq!(provider_account("qwen-dashscope"), "provider:qwen-dashscope");
    }
}
