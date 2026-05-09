//! Trigger advanced-OCR enhancement backfill when the local model
//! bundle finishes downloading.
//!
//! Local PP-StructureV3 ships as 13 separate model repos under the
//! ``advanced-ocr-*`` role prefix in the sidecar's manifest. The user
//! can enable the ``advanced-ocr`` feature long before all 13 stages
//! finish downloading; existing indexed documents should become eligible
//! for enhancement once the local bundle is usable.
//!
//! Mechanism: every 10 s, fetch ``GET /models/status`` and check
//! whether **every** ``advanced-ocr-*`` role reports ``state="ready"``.
//! On the false -> true transition, call the sidecar's idempotent
//! ``POST /index/backfill-enhancement`` endpoint once.

use std::sync::Arc;
use std::time::Duration;

use crate::services::search::client::SearchSidecarClient;
use crate::services::search::supervisor::{SearchSidecarSupervisor, SupervisorState};
use crate::services::search::SidecarEnvelopeState;

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const ERROR_BACKOFF: Duration = Duration::from_secs(30);
const AUTH_ERROR_BACKOFF: Duration = Duration::from_secs(300);
const ROLE_PREFIX: &str = "advanced-ocr-";

/// True iff the response carries at least one ``advanced-ocr-*`` role
/// AND every such role is in ``ready`` state.
fn advanced_ocr_all_ready(
    roles: &std::collections::HashMap<String, crate::services::search::client::ModelRoleStatusDto>,
) -> bool {
    let mut found_any = false;
    for (role, status) in roles.iter() {
        if !role.starts_with(ROLE_PREFIX) {
            continue;
        }
        found_any = true;
        if status.state != "ready" {
            return false;
        }
    }
    found_any
}

/// Long-lived watcher task. Loops until the supervisor is terminally
/// failed (matches the same exit policy as the index-state-sync
/// loop). Survives ``restart_sidecar`` cycles by re-checking state
/// rather than exiting on non-Running.
pub async fn run_advanced_ocr_watcher(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
) {
    log::info!("advanced-ocr-watcher: started (poll={:?})", POLL_INTERVAL);

    // First observation seeds the baseline; only later false -> true
    // transitions fire backfill.
    let mut last_all_ready: Option<bool> = None;

    loop {
        match supervisor.state() {
            SupervisorState::Running { .. } => {}
            SupervisorState::Failed {
                retryable: false, ..
            } => {
                log::info!("advanced-ocr-watcher: supervisor failed terminally; exiting loop");
                return;
            }
            other => {
                log::debug!("advanced-ocr-watcher: supervisor in {other:?}; waiting for Running");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        }

        let env = client.models_status().await;
        match env.state {
            SidecarEnvelopeState::Ready => {
                let Some(status) = env.data else {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                };
                let now_ready = advanced_ocr_all_ready(&status.roles);
                match last_all_ready {
                    None => {
                        log::debug!("advanced-ocr-watcher: initial all_ready={now_ready}");
                        last_all_ready = Some(now_ready);
                    }
                    Some(prev) if !prev && now_ready => {
                        request_backfill(&client).await;
                        last_all_ready = Some(true);
                    }
                    Some(_) => {
                        last_all_ready = Some(now_ready);
                    }
                }
            }
            SidecarEnvelopeState::Initialising => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            SidecarEnvelopeState::Unavailable => {
                log::debug!(
                    "advanced-ocr-watcher: sidecar unavailable ({}); backing off",
                    env.error.as_deref().unwrap_or("(no detail)")
                );
                tokio::time::sleep(ERROR_BACKOFF).await;
                continue;
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn request_backfill(client: &SearchSidecarClient) {
    log::info!("advanced-ocr-watcher: bundle just finished; requesting enhancement backfill");
    let backfill = client.backfill_advanced_ocr_enhancement().await;
    match backfill.state {
        SidecarEnvelopeState::Ready => {
            let flagged = backfill.data.map(|data| data.flagged).unwrap_or(0);
            log::info!(
                "advanced-ocr-watcher: enhancement backfill flagged {flagged} document node(s)"
            );
        }
        SidecarEnvelopeState::Initialising => {
            log::debug!("advanced-ocr-watcher: sidecar initialising during backfill");
        }
        SidecarEnvelopeState::Unavailable => {
            let detail = backfill.error.as_deref().unwrap_or("(no detail)");
            log::warn!("advanced-ocr-watcher: enhancement backfill failed: {detail}");
            if is_auth_failure_detail(detail) {
                tokio::time::sleep(AUTH_ERROR_BACKOFF).await;
            }
        }
    }
}

fn is_auth_failure_detail(detail: &str) -> bool {
    detail.contains("401") || detail.contains("403")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::search::client::ModelRoleStatusDto;
    use std::collections::HashMap;

    fn role(name: &str, state: &str) -> ModelRoleStatusDto {
        ModelRoleStatusDto {
            role: name.to_string(),
            state: state.to_string(),
            repo: String::new(),
            commit: None,
            error: None,
        }
    }

    #[test]
    fn all_ready_returns_false_when_no_advanced_ocr_roles_exist() {
        let mut roles = HashMap::new();
        roles.insert("embedding".to_string(), role("embedding", "ready"));
        assert!(!advanced_ocr_all_ready(&roles));
    }

    #[test]
    fn all_ready_returns_false_when_one_advanced_role_pending() {
        let mut roles = HashMap::new();
        roles.insert(
            "advanced-ocr-detection".to_string(),
            role("advanced-ocr-detection", "ready"),
        );
        roles.insert(
            "advanced-ocr-recognition".to_string(),
            role("advanced-ocr-recognition", "downloading"),
        );
        assert!(!advanced_ocr_all_ready(&roles));
    }

    #[test]
    fn all_ready_returns_true_when_every_advanced_role_ready() {
        let mut roles = HashMap::new();
        for stage in ["detection", "recognition", "layout"] {
            let key = format!("advanced-ocr-{stage}");
            roles.insert(key.clone(), role(&key, "ready"));
        }
        roles.insert("embedding".to_string(), role("embedding", "missing"));
        assert!(advanced_ocr_all_ready(&roles));
    }

    #[test]
    fn auth_failure_detail_detects_401_and_403() {
        assert!(is_auth_failure_detail("http 401 unauthorized"));
        assert!(is_auth_failure_detail("sidecar returned 403"));
        assert!(!is_auth_failure_detail("network reset"));
    }
}
