//! Safe sidecar drain helpers used before dev restarts and app quit.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::services::search::client::{IndexStatusDto, SearchSidecarClient};
use crate::services::search::supervisor::SearchSidecarSupervisor;
use crate::services::search::SidecarEnvelopeState;

const SAFE_DRAIN_POLL_INTERVAL: Duration = Duration::from_secs(1);
const RESTART_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const APP_CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const APP_CLOSE_SIGTERM_GRACE: Duration = Duration::from_secs(10);

pub async fn safe_restart_when_idle(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    app_handle: AppHandle,
    context: &str,
) {
    let outcome = pause_and_wait_until_idle(&client, context, RESTART_DRAIN_TIMEOUT).await;
    match outcome {
        DrainOutcome::Drained => {
            log::info!("{context}: active sidecar work drained; restarting sidecar");
        }
        DrainOutcome::TimedOut => {
            log::warn!(
                "{context}: active sidecar work did not drain within {:?}; restarting anyway",
                RESTART_DRAIN_TIMEOUT
            );
        }
        DrainOutcome::Proceeding => {
            log::info!("{context}: sidecar not ready for drain; restarting sidecar");
        }
    }
    if let Err(err) = supervisor.restart(&app_handle) {
        log::warn!("{context}: restart failed: {err}");
    }
}

pub async fn safe_stop_when_idle(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    context: &str,
) {
    let outcome = pause_and_wait_until_idle(&client, context, APP_CLOSE_DRAIN_TIMEOUT).await;
    match outcome {
        DrainOutcome::Drained => {
            log::info!("{context}: active sidecar work drained; stopping sidecar");
        }
        DrainOutcome::TimedOut => {
            log::warn!(
                "{context}: active sidecar work did not drain within {:?}; stopping sidecar anyway",
                APP_CLOSE_DRAIN_TIMEOUT
            );
        }
        DrainOutcome::Proceeding => {
            log::info!("{context}: sidecar not ready for drain; stopping sidecar");
        }
    }
    supervisor.stop_gracefully_with_timeout(APP_CLOSE_SIGTERM_GRACE);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DrainOutcome {
    Drained,
    TimedOut,
    Proceeding,
}

async fn pause_and_wait_until_idle(
    client: &SearchSidecarClient,
    context: &str,
    max_wait: Duration,
) -> DrainOutcome {
    let pause = client.set_indexing_paused(true).await;
    match pause.state {
        SidecarEnvelopeState::Ready => {
            log::info!("{context}: paused indexing before sidecar lifecycle action");
        }
        SidecarEnvelopeState::Initialising => {
            log::debug!("{context}: sidecar initialising before pause; proceeding");
            return DrainOutcome::Proceeding;
        }
        SidecarEnvelopeState::Unavailable => {
            log::debug!(
                "{context}: sidecar unavailable before pause ({}); proceeding",
                pause.error.as_deref().unwrap_or("(no detail)")
            );
            return DrainOutcome::Proceeding;
        }
    }

    let deadline = Instant::now() + max_wait;
    loop {
        let status = client.index_status().await;
        match status.state {
            SidecarEnvelopeState::Ready => {
                let Some(data) = status.data else {
                    return DrainOutcome::Proceeding;
                };
                if !index_status_has_active_work(&data) {
                    return DrainOutcome::Drained;
                }
                if Instant::now() >= deadline {
                    return DrainOutcome::TimedOut;
                }
                log::info!(
                    "{context}: waiting for active sidecar work (in_flight={}, enhancement_in_flight={})",
                    data.in_flight.len(),
                    data.enhancement_in_flight.len()
                );
            }
            SidecarEnvelopeState::Initialising => {
                log::debug!("{context}: sidecar initialising while waiting; proceeding");
                return DrainOutcome::Proceeding;
            }
            SidecarEnvelopeState::Unavailable => {
                log::debug!(
                    "{context}: sidecar unavailable while waiting ({}); proceeding",
                    status.error.as_deref().unwrap_or("(no detail)")
                );
                return DrainOutcome::Proceeding;
            }
        }
        tokio::time::sleep(SAFE_DRAIN_POLL_INTERVAL).await;
    }
}

fn index_status_has_active_work(status: &IndexStatusDto) -> bool {
    !status.in_flight.is_empty() || !status.enhancement_in_flight.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_queue_depth_does_not_block_safe_lifecycle_action() {
        let status = IndexStatusDto {
            queue_depth: 42,
            in_flight: vec![],
            enhancement_in_flight: vec![],
            indexed_chunks: 0,
            enhancement_pending: 42,
            enhancement_failed: 0,
            enhancement_total_images: 42,
        };
        assert!(!index_status_has_active_work(&status));
    }

    #[test]
    fn active_basic_or_enhancement_work_blocks_safe_lifecycle_action() {
        let mut status = IndexStatusDto {
            queue_depth: 0,
            in_flight: vec!["node-a".to_string()],
            enhancement_in_flight: vec![],
            indexed_chunks: 0,
            enhancement_pending: 0,
            enhancement_failed: 0,
            enhancement_total_images: 0,
        };
        assert!(index_status_has_active_work(&status));

        status.in_flight.clear();
        status.enhancement_in_flight.push("node-b".to_string());
        assert!(index_status_has_active_work(&status));
    }
}
