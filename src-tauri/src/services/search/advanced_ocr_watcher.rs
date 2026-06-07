//! Trigger advanced-OCR enhancement tasks when the local model bundle
//! finishes downloading.
//!
//! Local PP-StructureV3 ships as 13 separate model repos under the
//! ``advanced-ocr-*`` role prefix in the sidecar's manifest. The user
//! can enable the ``advanced-ocr`` feature long before all 13 stages
//! finish downloading; existing indexed documents should become eligible
//! for enhancement once the local bundle is usable.
//!
//! Mechanism: every 10 s, fetch ``GET /models/status`` and check
//! whether **every** ``advanced-ocr-*`` role reports ``state="ready"``.
//! On the false -> true transition, enqueue missing ``image.enhance``
//! background tasks in Rust's durable task table. The sidecar only
//! executes one node at a time when Rust posts ``/index/enhance``.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::domain::node_status::StageUpdate;
use crate::infrastructure::db::background_task_repository::{
    claim_next_background_task, complete_background_task, defer_background_task,
    enqueue_background_task, enqueue_background_task_if_missing, fail_background_task,
    has_queued_background_tasks, recover_background_tasks, BackgroundTask, BackgroundTaskFailure,
};
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::node_status_repository::update_stage;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::{EnhanceNodeResultDto, SearchSidecarClient};
use crate::services::search::forwarder::build_payload;
use crate::services::search::supervisor::{SearchSidecarSupervisor, SupervisorState};
use crate::services::search::{SidecarEnvelope, SidecarEnvelopeState};
use crate::VfsEventEmitter;

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const ERROR_BACKOFF: Duration = Duration::from_secs(30);
const ROLE_PREFIX: &str = "advanced-ocr-";
const IMAGE_ENHANCE_TASK_TYPE: &str = "image.enhance";
const DEFERRED_ENHANCEMENT_ERRORS: &[&str] = &[
    "advanced OCR runtime is unavailable",
    "sidecar initialising",
    "sidecar unavailable",
];
const ENHANCEMENT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "pdf"];
static IMAGE_ENHANCE_DRAIN_RUNNING: AtomicBool = AtomicBool::new(false);

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
    db: Database,
    storage_dir: PathBuf,
    emitter: VfsEventEmitter,
) {
    log::info!("advanced-ocr-watcher: started (poll={:?})", POLL_INTERVAL);
    if let Ok(conn) = db.connect() {
        if let Ok(recovered) = recover_background_tasks(&conn, IMAGE_ENHANCE_TASK_TYPE) {
            if recovered > 0 {
                log::info!("advanced-ocr-watcher: recovered {recovered} enhancement task(s)");
            }
        }
        if let Ok(recovered) = recover_deferred_enhancement_tasks(&conn) {
            for node_id in recovered.iter() {
                let _ = update_stage(
                    &conn,
                    node_id,
                    IMAGE_ENHANCE_TASK_TYPE,
                    &StageUpdate::pending("Enhancement queued"),
                );
                emitter(VfsChangeEvent {
                    mount_id: node_id.clone(),
                    reason: "node-saved".to_string(),
                    ..Default::default()
                });
            }
            if !recovered.is_empty() {
                log::info!(
                    "advanced-ocr-watcher: requeued {} deferred enhancement task(s)",
                    recovered.len()
                );
            }
        }
    }

    // If the bundle is already ready on startup, drain immediately;
    // otherwise wait for the first false -> true transition.
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
                        if now_ready {
                            request_backfill(&db, &emitter);
                            spawn_enhancement_drain(
                                db.clone(),
                                Arc::clone(&client),
                                storage_dir.clone(),
                                Arc::clone(&emitter),
                            );
                        }
                        last_all_ready = Some(now_ready);
                    }
                    Some(prev) if !prev && now_ready => {
                        request_backfill(&db, &emitter);
                        spawn_enhancement_drain(
                            db.clone(),
                            Arc::clone(&client),
                            storage_dir.clone(),
                            Arc::clone(&emitter),
                        );
                        last_all_ready = Some(true);
                    }
                    Some(_) => {
                        if now_ready {
                            spawn_enhancement_drain(
                                db.clone(),
                                Arc::clone(&client),
                                storage_dir.clone(),
                                Arc::clone(&emitter),
                            );
                        }
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

fn request_backfill(db: &Database, emitter: &VfsEventEmitter) {
    let Ok(conn) = db.connect() else {
        log::warn!("advanced-ocr-watcher: could not open DB for enhancement backfill");
        return;
    };
    let node_ids = match eligible_enhancement_node_ids(&conn) {
        Ok(node_ids) => node_ids,
        Err(error) => {
            log::warn!("advanced-ocr-watcher: enhancement eligibility scan failed: {error}");
            return;
        }
    };
    let mut flagged = 0;
    for node_id in node_ids {
        if matches!(
            enqueue_background_task_if_missing(&conn, &node_id, IMAGE_ENHANCE_TASK_TYPE, None, 3),
            Ok(Some(_))
        ) {
            flagged += 1;
            let _ = update_stage(
                &conn,
                &node_id,
                "image.enhance",
                &StageUpdate::pending("Enhancement queued"),
            );
            emitter(VfsChangeEvent {
                mount_id: node_id,
                reason: "node-saved".to_string(),
                ..Default::default()
            });
        }
    }
    log::info!("advanced-ocr-watcher: queued {flagged} enhancement task(s)");
}

fn recover_deferred_enhancement_tasks(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let placeholders = DEFERRED_ENHANCEMENT_ERRORS
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let select_sql = format!(
        "
        SELECT node_id
        FROM background_tasks
        WHERE task_type = ?
          AND status = 'failed'
          AND last_error IN ({placeholders})
        ORDER BY updated_at ASC, node_id ASC
        "
    );
    let mut select_params: Vec<&dyn rusqlite::ToSql> =
        vec![&IMAGE_ENHANCE_TASK_TYPE as &dyn rusqlite::ToSql];
    select_params.extend(
        DEFERRED_ENHANCEMENT_ERRORS
            .iter()
            .map(|error| error as &dyn rusqlite::ToSql),
    );
    let mut stmt = conn
        .prepare(&select_sql)
        .map_err(|error| error.to_string())?;
    let node_ids = stmt
        .query_map(rusqlite::params_from_iter(select_params), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    let update_sql = format!(
        "
        UPDATE background_tasks
        SET status = 'queued',
            attempt = 0,
            last_error = NULL,
            locked_at = NULL,
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE task_type = ?
          AND status = 'failed'
          AND last_error IN ({placeholders})
        "
    );
    let mut update_params: Vec<&dyn rusqlite::ToSql> =
        vec![&IMAGE_ENHANCE_TASK_TYPE as &dyn rusqlite::ToSql];
    update_params.extend(
        DEFERRED_ENHANCEMENT_ERRORS
            .iter()
            .map(|error| error as &dyn rusqlite::ToSql),
    );
    conn.execute(&update_sql, rusqlite::params_from_iter(update_params))
        .map_err(|error| error.to_string())?;
    Ok(node_ids)
}

fn eligible_enhancement_node_ids(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT n.id
            FROM nodes n
            LEFT JOIN background_tasks t
              ON t.node_id = n.id
             AND t.task_type = ?1
             AND t.status IN ('queued', 'running', 'succeeded', 'failed')
            WHERE n.kind = 'file'
              AND n.state = 'indexed'
              AND t.id IS NULL
            ORDER BY n.updated_at ASC, n.id ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([IMAGE_ENHANCE_TASK_TYPE], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let ids = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(ids
        .into_iter()
        .filter(|id| node_name_has_extension(conn, id).unwrap_or(false))
        .collect())
}

fn node_name_has_extension(conn: &rusqlite::Connection, node_id: &str) -> Result<bool, String> {
    let name: String = conn
        .query_row("SELECT name FROM nodes WHERE id = ?1", [node_id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let lower = name.to_lowercase();
    Ok(ENHANCEMENT_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}"))))
}

fn spawn_enhancement_drain(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: PathBuf,
    emitter: VfsEventEmitter,
) {
    if IMAGE_ENHANCE_DRAIN_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let drained_normally = run_enhancement_drain(
            db.clone(),
            Arc::clone(&client),
            storage_dir.clone(),
            Arc::clone(&emitter),
        )
        .await;
        IMAGE_ENHANCE_DRAIN_RUNNING.store(false, Ordering::SeqCst);
        let should_resume = db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| has_queued_background_tasks(&conn, IMAGE_ENHANCE_TASK_TYPE))
            .unwrap_or(false);
        if drained_normally && should_resume {
            spawn_enhancement_drain(db, client, storage_dir, emitter);
        }
    });
}

async fn run_enhancement_drain(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: PathBuf,
    emitter: VfsEventEmitter,
) -> bool {
    loop {
        let task = match db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| claim_next_background_task(&conn, IMAGE_ENHANCE_TASK_TYPE))
        {
            Ok(Some(task)) => task,
            Ok(None) => return true,
            Err(error) => {
                log::warn!("advanced-ocr-watcher: enhancement claim failed: {error}");
                return true;
            }
        };
        if !run_enhancement_task(&db, &client, &storage_dir, &emitter, task).await {
            return false;
        }
    }
}

async fn run_enhancement_task(
    db: &Database,
    client: &SearchSidecarClient,
    storage_dir: &std::path::Path,
    emitter: &VfsEventEmitter,
    task: BackgroundTask,
) -> bool {
    let conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            log::warn!("advanced-ocr-watcher: could not open DB: {error}");
            return false;
        }
    };
    let _ = update_stage(
        &conn,
        &task.node_id,
        "image.enhance",
        &StageUpdate::running("Enhancing"),
    );
    emitter(VfsChangeEvent {
        mount_id: task.node_id.clone(),
        reason: "node-saved".to_string(),
        ..Default::default()
    });
    drop(conn);

    let event = VfsChangeEvent {
        mount_id: task.node_id.clone(),
        reason: "node-saved".to_string(),
        ..Default::default()
    };
    let Some(payload) = build_payload(&event, db, storage_dir) else {
        fail_enhancement_task(
            db,
            emitter,
            &task,
            "node unavailable for enhancement",
            false,
        );
        return true;
    };

    match client.enhance_node(&payload).await {
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: Some(EnhanceNodeResultDto { status, error: _ }),
            ..
        } if status == "completed" => complete_enhancement_task(db, emitter, &task),
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: Some(EnhanceNodeResultDto { error, .. }),
            ..
        } => {
            let message = error.as_deref().unwrap_or("enhancement failed");
            if is_deferred_enhancement_detail(message) {
                defer_enhancement_task(db, emitter, &task, message);
                return false;
            }
            fail_enhancement_task(db, emitter, &task, message, true);
        }
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: None,
            error,
        } => fail_enhancement_task(
            db,
            emitter,
            &task,
            error
                .as_deref()
                .unwrap_or("enhancement returned no response body"),
            true,
        ),
        SidecarEnvelope {
            state: SidecarEnvelopeState::Initialising,
            ..
        } => {
            defer_enhancement_task(db, emitter, &task, "sidecar initialising");
            return false;
        }
        SidecarEnvelope {
            state: SidecarEnvelopeState::Unavailable,
            error,
            ..
        } => {
            let message = error.as_deref().unwrap_or("sidecar unavailable");
            if is_auth_failure_detail(message) {
                fail_enhancement_task(db, emitter, &task, message, false);
            } else {
                defer_enhancement_task(db, emitter, &task, message);
                return false;
            }
        }
    }
    true
}

fn complete_enhancement_task(db: &Database, emitter: &VfsEventEmitter, task: &BackgroundTask) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let _ = complete_background_task(&conn, task);
    let _ = update_stage(
        &conn,
        &task.node_id,
        "image.enhance",
        &StageUpdate::succeeded("Enhancement ready"),
    );
    emitter(VfsChangeEvent {
        mount_id: task.node_id.clone(),
        reason: "node-saved".to_string(),
        ..Default::default()
    });
}

fn fail_enhancement_task(
    db: &Database,
    emitter: &VfsEventEmitter,
    task: &BackgroundTask,
    message: &str,
    retryable: bool,
) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let outcome = fail_background_task(&conn, task, message, retryable);
    let stage_update = match outcome {
        Ok(BackgroundTaskFailure::Requeued) => StageUpdate::pending("Enhancement retry queued"),
        Ok(BackgroundTaskFailure::Failed) => StageUpdate::failed(message, retryable),
        Ok(BackgroundTaskFailure::Stale) | Err(_) => return,
    };
    let _ = update_stage(&conn, &task.node_id, "image.enhance", &stage_update);
    emitter(VfsChangeEvent {
        mount_id: task.node_id.clone(),
        reason: "node-saved".to_string(),
        ..Default::default()
    });
}

fn defer_enhancement_task(
    db: &Database,
    emitter: &VfsEventEmitter,
    task: &BackgroundTask,
    message: &str,
) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let outcome = defer_background_task(&conn, task, message);
    if matches!(outcome, Ok(BackgroundTaskFailure::Requeued)) {
        let _ = update_stage(
            &conn,
            &task.node_id,
            IMAGE_ENHANCE_TASK_TYPE,
            &StageUpdate::pending("Enhancement queued"),
        );
        emitter(VfsChangeEvent {
            mount_id: task.node_id.clone(),
            reason: "node-saved".to_string(),
            ..Default::default()
        });
    }
}

pub fn enqueue_image_enhancement_for_reindex(
    conn: &rusqlite::Connection,
    node_id: &str,
) -> Result<(), String> {
    enqueue_background_task(conn, node_id, IMAGE_ENHANCE_TASK_TYPE, None, 3)?;
    update_stage(
        conn,
        node_id,
        "image.enhance",
        &StageUpdate::pending("Enhancement queued"),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn spawn_image_enhancement_drain_for_reindex(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: PathBuf,
    emitter: VfsEventEmitter,
) {
    spawn_enhancement_drain(db, client, storage_dir, emitter);
}

fn is_auth_failure_detail(detail: &str) -> bool {
    detail.contains("401") || detail.contains("403")
}

fn is_deferred_enhancement_detail(detail: &str) -> bool {
    DEFERRED_ENHANCEMENT_ERRORS.contains(&detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::connection::Database;
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

    #[test]
    fn deferred_enhancement_task_returns_to_queue_without_consuming_attempt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('image-1', 'file', 'scan.png', 'indexed', 10)",
            [],
        )
        .expect("node");
        enqueue_background_task(&conn, "image-1", IMAGE_ENHANCE_TASK_TYPE, None, 3)
            .expect("enqueue");
        let task = claim_next_background_task(&conn, IMAGE_ENHANCE_TASK_TYPE)
            .expect("claim")
            .expect("task");
        drop(conn);

        let emitter: VfsEventEmitter = Arc::new(|_| {});
        defer_enhancement_task(&db, &emitter, &task, "advanced OCR runtime is unavailable");

        let conn = db.connect().expect("db");
        let (status, attempt, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempt, last_error
                 FROM background_tasks
                 WHERE node_id = 'image-1' AND task_type = ?1",
                [IMAGE_ENHANCE_TASK_TYPE],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("task row");
        assert_eq!(status, "queued");
        assert_eq!(attempt, 0);
        assert_eq!(
            last_error.as_deref(),
            Some("advanced OCR runtime is unavailable")
        );
    }

    #[test]
    fn startup_recovery_requeues_deferred_enhancement_failures() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('image-1', 'file', 'scan.png', 'indexed', 10)",
            [],
        )
        .expect("node");
        enqueue_background_task(&conn, "image-1", IMAGE_ENHANCE_TASK_TYPE, None, 3)
            .expect("enqueue");
        conn.execute(
            "
            UPDATE background_tasks
            SET status = 'failed',
                attempt = 3,
                last_error = 'advanced OCR runtime is unavailable',
                completed_at = CURRENT_TIMESTAMP
            WHERE node_id = 'image-1'
              AND task_type = ?1
            ",
            [IMAGE_ENHANCE_TASK_TYPE],
        )
        .expect("failed task");

        let recovered = recover_deferred_enhancement_tasks(&conn).expect("recover");

        assert_eq!(recovered, vec!["image-1".to_string()]);
        let (status, attempt, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempt, last_error
                 FROM background_tasks
                 WHERE node_id = 'image-1' AND task_type = ?1",
                [IMAGE_ENHANCE_TASK_TYPE],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("task row");
        assert_eq!(status, "queued");
        assert_eq!(attempt, 0);
        assert_eq!(last_error, None);
    }
}
