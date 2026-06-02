//! Direct-from-disk settings reader for degraded mode.
//!
//! When the Python sidecar fails to start (lock contention, port
//! issue, broken provider config crashing init), the Settings UI
//! still needs to load *something* so the user can see what's
//! configured and manually edit ``~/.cogios/search/settings.json``
//! to recover. This module reads the same file the sidecar reads,
//! parsed into the same DTO shape, but without going through the
//! sidecar's HTTP layer.
//!
//! Read-only. No write fallback — all writes still go through the
//! sidecar so its on-disk schema validation runs and ``needs_restart``
//! is recomputed.

use std::path::Path;

use super::client::SearchSettingsDto;

/// Read and parse ``settings.json`` directly. Returns the parsed DTO
/// with ``needs_restart=false`` (no live sidecar to compare against
/// a boot signature). On parse failure or missing file, returns an
/// error string the caller can surface to the user.
pub fn read_settings_file_fallback(settings_path: &Path) -> Result<SearchSettingsDto, String> {
    let bytes = std::fs::read(settings_path)
        .map_err(|err| format!("read {}: {}", settings_path.display(), err))?;
    let mut dto: SearchSettingsDto = serde_json::from_slice(&bytes)
        .map_err(|err| format!("parse {}: {}", settings_path.display(), err))?;
    // Force the field to false — without a live sidecar boot
    // signature, we can't compare; UI shouldn't claim restart-required
    // when there's nothing to restart.
    dto.needs_restart = false;
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_temp(contents: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn reads_a_minimal_settings_file() {
        let f = write_temp(
            r#"{"version": 1, "providers": {}, "features": {},
                "cloud_consent_acked": [], "first_run_skipped": false}"#,
        );
        let dto = read_settings_file_fallback(f.path()).expect("read");
        assert_eq!(dto.version, 1);
        assert!(dto.providers.is_empty());
        assert!(!dto.first_run_skipped);
        assert!(!dto.needs_restart);
    }

    #[test]
    fn forces_needs_restart_to_false_even_if_present_in_file() {
        let f = write_temp(
            r#"{"version": 1, "providers": {}, "features": {},
                "cloud_consent_acked": [], "first_run_skipped": false,
                "needs_restart": true}"#,
        );
        let dto = read_settings_file_fallback(f.path()).expect("read");
        // Live needs_restart can't be computed without a sidecar; we
        // refuse to surface a stale-on-disk value.
        assert!(!dto.needs_restart);
    }

    #[test]
    fn returns_error_on_missing_file() {
        let path = std::path::Path::new("/tmp/this/does/not/exist/settings.json");
        let err = read_settings_file_fallback(path).unwrap_err();
        assert!(err.contains("read"));
    }

    #[test]
    fn returns_error_on_malformed_json() {
        let f = write_temp("{not valid json");
        let err = read_settings_file_fallback(f.path()).unwrap_err();
        assert!(err.contains("parse"));
    }

    #[test]
    fn round_trips_provider_and_feature_data() {
        let f = write_temp(
            r#"{
                "version": 1,
                "providers": {
                    "openai": {
                        "provider_id": "openai",
                        "enabled": true,
                        "api_key_ref": "env-file://cogios/.env#openai",
                        "base_url": null,
                        "model_per_capability": {"embedding": "text-embedding-3-small"}
                    }
                },
                "features": {
                    "semantic-search": {"enabled": true, "provider_id": "openai"}
                },
                "cloud_consent_acked": ["openai"],
                "first_run_skipped": false
            }"#,
        );
        let dto = read_settings_file_fallback(f.path()).expect("read");
        let openai = dto.providers.get("openai").expect("openai present");
        assert_eq!(openai.provider_id, "openai");
        assert_eq!(
            openai.api_key_ref.as_deref(),
            Some("env-file://cogios/.env#openai")
        );
        assert_eq!(
            openai
                .model_per_capability
                .get("embedding")
                .map(String::as_str),
            Some("text-embedding-3-small")
        );
        let feature = dto.features.get("semantic-search").expect("present");
        assert_eq!(feature.provider_id.as_deref(), Some("openai"));
        assert_eq!(dto.cloud_consent_acked, vec!["openai".to_string()]);
    }
}
