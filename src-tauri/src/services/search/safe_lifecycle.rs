//! Safe sidecar drain helpers used before dev restarts and app quit.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::services::search::client::{IndexStatusDto, SearchSidecarClient, SidecarEnvelope};
use crate::services::search::supervisor::SearchSidecarSupervisor;
use crate::services::search::SidecarEnvelopeState;

const SAFE_DRAIN_POLL_INTERVAL: Duration = Duration::from_secs(1);
const SAFE_DRAIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const RESTART_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const APP_CLOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const APP_CLOSE_SIGTERM_GRACE: Duration = Duration::from_secs(3);

pub async fn safe_restart_when_idle(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    app_handle: AppHandle,
    context: &str,
) {
    let outcome = pause_and_wait_until_idle(
        &client,
        context,
        RESTART_DRAIN_TIMEOUT,
        ActiveWorkPolicy::IndexingAndEnhancement,
    )
    .await;
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
    let outcome = pause_and_wait_until_idle(
        &client,
        context,
        APP_CLOSE_DRAIN_TIMEOUT,
        ActiveWorkPolicy::IndexingOnly,
    )
    .await;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveWorkPolicy {
    IndexingAndEnhancement,
    IndexingOnly,
}

async fn pause_and_wait_until_idle(
    client: &SearchSidecarClient,
    context: &str,
    max_wait: Duration,
    active_work_policy: ActiveWorkPolicy,
) -> DrainOutcome {
    let deadline = Instant::now() + max_wait;
    let pause = match drain_request(
        client.set_indexing_paused(true),
        context,
        "pause indexing",
        deadline,
    )
    .await
    {
        Ok(envelope) => envelope,
        Err(outcome) => return outcome,
    };
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

    loop {
        if Instant::now() >= deadline {
            return DrainOutcome::TimedOut;
        }
        let status = match drain_request(
            client.index_status(),
            context,
            "read index status",
            deadline,
        )
        .await
        {
            Ok(envelope) => envelope,
            Err(outcome) => return outcome,
        };
        match status.state {
            SidecarEnvelopeState::Ready => {
                let Some(data) = status.data else {
                    return DrainOutcome::Proceeding;
                };
                if !index_status_has_active_work(&data, active_work_policy) {
                    if active_work_policy == ActiveWorkPolicy::IndexingOnly
                        && !data.enhancement_in_flight.is_empty()
                    {
                        log::info!(
                            "{context}: proceeding with restartable enhancement work still active ({})",
                            data.enhancement_in_flight.len()
                        );
                    }
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

async fn drain_request<T>(
    request: impl Future<Output = SidecarEnvelope<T>>,
    context: &str,
    action: &str,
    deadline: Instant,
) -> Result<SidecarEnvelope<T>, DrainOutcome> {
    let Some(timeout) = drain_request_timeout(deadline) else {
        return Err(DrainOutcome::TimedOut);
    };
    match tokio::time::timeout(timeout, request).await {
        Ok(envelope) => Ok(envelope),
        Err(_) if Instant::now() >= deadline => Err(DrainOutcome::TimedOut),
        Err(_) => {
            log::debug!("{context}: sidecar {action} timed out after {timeout:?}; proceeding");
            Err(DrainOutcome::Proceeding)
        }
    }
}

fn drain_request_timeout(deadline: Instant) -> Option<Duration> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    if remaining.is_zero() {
        None
    } else {
        Some(remaining.min(SAFE_DRAIN_REQUEST_TIMEOUT))
    }
}

fn index_status_has_active_work(status: &IndexStatusDto, policy: ActiveWorkPolicy) -> bool {
    match policy {
        ActiveWorkPolicy::IndexingAndEnhancement => {
            !status.in_flight.is_empty() || !status.enhancement_in_flight.is_empty()
        }
        ActiveWorkPolicy::IndexingOnly => !status.in_flight.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_background_tasks_do_not_block_safe_lifecycle_action() {
        let status = IndexStatusDto {
            in_flight: vec![],
            enhancement_in_flight: vec![],
            indexed_chunks: 0,
            enhancement_pending: 42,
            enhancement_failed: 0,
            enhancement_total_images: 42,
            tasks: vec![],
            task_totals: Default::default(),
        };
        assert!(!index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingAndEnhancement
        ));
        assert!(!index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingOnly
        ));
    }

    #[test]
    fn active_basic_or_enhancement_work_blocks_safe_lifecycle_action() {
        let mut status = IndexStatusDto {
            in_flight: vec!["node-a".to_string()],
            enhancement_in_flight: vec![],
            indexed_chunks: 0,
            enhancement_pending: 0,
            enhancement_failed: 0,
            enhancement_total_images: 0,
            tasks: vec![],
            task_totals: Default::default(),
        };
        assert!(index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingAndEnhancement
        ));
        assert!(index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingOnly
        ));

        status.in_flight.clear();
        status.enhancement_in_flight.push("node-b".to_string());
        assert!(index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingAndEnhancement
        ));
        assert!(!index_status_has_active_work(
            &status,
            ActiveWorkPolicy::IndexingOnly
        ));
    }

    #[test]
    fn drain_request_timeout_is_capped_by_request_timeout() {
        let deadline = Instant::now() + Duration::from_secs(30);
        assert_eq!(
            drain_request_timeout(deadline),
            Some(SAFE_DRAIN_REQUEST_TIMEOUT)
        );
    }

    #[test]
    fn drain_request_timeout_respects_near_deadline() {
        let deadline = Instant::now() + Duration::from_millis(500);
        let timeout = drain_request_timeout(deadline).expect("timeout");
        assert!(timeout <= Duration::from_millis(500));
    }
}
