//! Rust-owned search indexing task queue.
//!
//! `search.index` is the durable task that syncs a node into the
//! sidecar's search projection. The sidecar still owns extraction and
//! LanceDB writes, but Rust owns scheduling, retry, and UI-visible
//! status transitions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::domain::node_status::{StageState, StageUpdate};
use crate::infrastructure::db::background_task_repository::{
    cancel_background_tasks, claim_next_background_task, complete_background_task,
    defer_background_task, enqueue_background_task, fail_background_task,
    has_queued_background_tasks, recover_background_tasks, BackgroundTask, BackgroundTaskFailure,
};
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::node_status_repository::{
    get_node_status_changed_event, node_supports_stage, update_stage, NODE_STATUS_CHANGED_EVENT,
};
use crate::infrastructure::db::statistics_repository::{
    increment_daily_stat, INDEXED_NODES_METRIC,
};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::advanced_ocr_watcher::{
    enqueue_image_enhancement_for_reindex, spawn_image_enhancement_drain_for_reindex,
};
use crate::services::search::client::{
    IndexNodeResultDto, NodeEvent, NodeEventKind, SearchSidecarClient,
};
use crate::services::search::forwarder::build_payload;
use crate::services::search::index_state_sync::{
    apply_search_index_transitions, SearchIndexTransition,
};
use crate::services::search::{SidecarEnvelope, SidecarEnvelopeState};
use crate::VfsEventEmitter;

pub const SEARCH_INDEX_TASK_TYPE: &str = "search.index";
const VFS_EVENT_NAME: &str = "vfs://changed";
static SEARCH_INDEX_DRAIN_RUNNING: AtomicBool = AtomicBool::new(false);

pub async fn handle_vfs_event(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: std::path::PathBuf,
    app_handle: AppHandle,
    event: VfsChangeEvent,
) {
    let Some(payload) = build_payload(&event, &db, &storage_dir) else {
        return;
    };
    if matches!(payload.event, NodeEventKind::NodeDeleted) {
        if let Ok(conn) = db.connect() {
            let _ = cancel_background_tasks(&conn, &payload.node_id, SEARCH_INDEX_TASK_TYPE);
        }
        let _ = client.delete_index_node(&payload.node_id).await;
        return;
    }

    let force = payload.force.unwrap_or(true);
    if let Err(error) = enqueue_search_index_task(&db, &payload.node_id, force) {
        log::warn!(
            "search-indexer: failed to enqueue {}: {error}",
            payload.node_id
        );
        return;
    }
    emit_vfs_refresh(&app_handle);
    spawn_search_index_drain(db, client, storage_dir, app_handle);
}

pub fn resume_search_index_tasks(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: std::path::PathBuf,
    app_handle: AppHandle,
) -> Result<(), String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    recover_background_tasks(&conn, SEARCH_INDEX_TASK_TYPE)?;
    let deferred_paused = recover_deferred_search_index_tasks(&conn)?;
    let recovered = enqueue_startup_search_index_tasks(&conn)?;
    if recovered > 0 {
        log::info!("search-indexer: queued {recovered} startup index task(s)");
    }
    drop(conn);
    if !deferred_paused.is_empty() {
        let transitions = deferred_paused
            .into_iter()
            .map(|node_id| SearchIndexTransition {
                node_id,
                state: "pending".to_string(),
                indexed_at: None,
                error: None,
            })
            .collect::<Vec<_>>();
        let _ = apply_search_index_transitions(&db, &transitions);
    }
    spawn_search_index_drain(db, client, storage_dir, app_handle);
    Ok(())
}

pub fn enqueue_search_index_task(db: &Database, node_id: &str, force: bool) -> Result<(), String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    enqueue_background_task(
        &conn,
        node_id,
        SEARCH_INDEX_TASK_TYPE,
        Some(serde_json::json!({ "force": force })),
        3,
    )?;
    let pending = vec![SearchIndexTransition {
        node_id: node_id.to_string(),
        state: "pending".to_string(),
        indexed_at: None,
        error: None,
    }];
    let _ = apply_search_index_transitions(db, &pending);
    if node_supports_stage(&conn, node_id, SEARCH_INDEX_TASK_TYPE).unwrap_or(false) {
        let _ = update_stage(
            &conn,
            node_id,
            SEARCH_INDEX_TASK_TYPE,
            &StageUpdate::pending("Waiting to index"),
        );
    }
    Ok(())
}

fn spawn_search_index_drain(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: std::path::PathBuf,
    app_handle: AppHandle,
) {
    if SEARCH_INDEX_DRAIN_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_search_index_drain(
            db.clone(),
            Arc::clone(&client),
            storage_dir.clone(),
            app_handle.clone(),
        )
        .await;
        SEARCH_INDEX_DRAIN_RUNNING.store(false, Ordering::SeqCst);
        let should_resume = db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| has_queued_background_tasks(&conn, SEARCH_INDEX_TASK_TYPE))
            .unwrap_or(false);
        if should_resume {
            spawn_search_index_drain(db, client, storage_dir, app_handle);
        }
    });
}

fn enqueue_startup_search_index_tasks(conn: &rusqlite::Connection) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT n.id
            FROM nodes n
            LEFT JOIN background_tasks t
              ON t.node_id = n.id
             AND t.task_type = ?1
             AND t.status IN ('queued', 'running', 'succeeded')
            LEFT JOIN urls u
              ON u.node_id = n.id
            WHERE t.id IS NULL
              AND (
                (n.kind IN ('file', 'note') AND n.state IN ('ready', 'pending', 'indexing'))
                OR
                (n.kind = 'url' AND u.html_cache_path IS NOT NULL AND n.state != 'error')
              )
            ORDER BY n.updated_at ASC, n.id ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([SEARCH_INDEX_TASK_TYPE], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let node_ids = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let mut queued = 0;
    for node_id in node_ids {
        enqueue_background_task(
            conn,
            &node_id,
            SEARCH_INDEX_TASK_TYPE,
            Some(serde_json::json!({ "force": false })),
            3,
        )?;
        queued += 1;
    }
    Ok(queued)
}

async fn run_search_index_drain(
    db: Database,
    client: Arc<SearchSidecarClient>,
    storage_dir: std::path::PathBuf,
    app_handle: AppHandle,
) {
    loop {
        let task = match db
            .connect()
            .map_err(|error| error.to_string())
            .and_then(|conn| claim_next_background_task(&conn, SEARCH_INDEX_TASK_TYPE))
        {
            Ok(Some(task)) => task,
            Ok(None) => return,
            Err(error) => {
                log::warn!("search-indexer: task claim failed: {error}");
                return;
            }
        };
        if !run_search_index_task(&db, &client, &storage_dir, &app_handle, task).await {
            return;
        }
    }
}

async fn run_search_index_task(
    db: &Database,
    client: &SearchSidecarClient,
    storage_dir: &std::path::Path,
    app_handle: &AppHandle,
    task: BackgroundTask,
) -> bool {
    let force = task_force(&task);
    let event = VfsChangeEvent {
        mount_id: task.node_id.clone(),
        reason: "node-saved".to_string(),
        ..Default::default()
    };
    let Some(mut payload) = build_payload(&event, db, storage_dir) else {
        complete_task(db, app_handle, &task, "missing");
        return true;
    };
    payload.force = Some(force);
    apply_running(db, app_handle, &task.node_id);

    match client.index_node(&payload).await {
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: Some(result),
            ..
        } => {
            handle_index_result(db, client, storage_dir, app_handle, &task, &payload, result);
            true
        }
        SidecarEnvelope {
            state: SidecarEnvelopeState::Initialising,
            ..
        } => {
            defer_task(db, app_handle, &task, "sidecar initialising");
            false
        }
        SidecarEnvelope {
            state: SidecarEnvelopeState::Unavailable,
            error,
            ..
        } => {
            defer_task(
                db,
                app_handle,
                &task,
                error.as_deref().unwrap_or("sidecar unavailable"),
            );
            false
        }
        SidecarEnvelope {
            state: SidecarEnvelopeState::Ready,
            data: None,
            error,
        } => {
            fail_task(
                db,
                app_handle,
                &task,
                error
                    .as_deref()
                    .unwrap_or("index returned no response body"),
                true,
            );
            true
        }
    }
}

fn handle_index_result(
    db: &Database,
    client: &SearchSidecarClient,
    storage_dir: &std::path::Path,
    app_handle: &AppHandle,
    task: &BackgroundTask,
    payload: &NodeEvent,
    result: IndexNodeResultDto,
) {
    match result.status.as_str() {
        "indexed" => {
            complete_task(db, app_handle, task, "Indexed");
            maybe_enqueue_image_enhancement(db, client, storage_dir, app_handle, payload);
        }
        "error" if is_no_processor_error(result.error.as_deref()) => {
            complete_task_with_state(
                db,
                app_handle,
                task,
                "unsupported",
                "No index processor available",
            );
        }
        "error" => fail_task(
            db,
            app_handle,
            task,
            result.error.as_deref().unwrap_or("indexing failed"),
            true,
        ),
        "paused" => defer_task(db, app_handle, task, "indexing runner is paused"),
        other => fail_task(
            db,
            app_handle,
            task,
            &format!("unexpected index status: {other}"),
            true,
        ),
    }
}

fn recover_deferred_search_index_tasks(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT node_id
            FROM background_tasks
            WHERE task_type = ?1
              AND status = 'failed'
              AND last_error IN (
                'indexing runner is paused',
                'sidecar initialising',
                'sidecar unavailable'
              )
            ORDER BY updated_at ASC, node_id ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let node_ids = stmt
        .query_map([SEARCH_INDEX_TASK_TYPE], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    conn.execute(
        "
        UPDATE background_tasks
        SET status = 'queued',
            attempt = 0,
            last_error = NULL,
            locked_at = NULL,
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE task_type = ?1
          AND status = 'failed'
          AND last_error IN (
            'indexing runner is paused',
            'sidecar initialising',
            'sidecar unavailable'
          )
        ",
        [SEARCH_INDEX_TASK_TYPE],
    )
    .map_err(|error| error.to_string())?;
    Ok(node_ids)
}

fn complete_task(db: &Database, app_handle: &AppHandle, task: &BackgroundTask, message: &str) {
    complete_task_with_state(db, app_handle, task, "indexed", message);
}

fn complete_task_with_state(
    db: &Database,
    app_handle: &AppHandle,
    task: &BackgroundTask,
    state: &str,
    message: &str,
) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let _ = complete_background_task(&conn, task);
    drop(conn);
    apply_index_transition(db, &task.node_id, state, None, None);
    if let Ok(conn) = db.connect() {
        if state == "indexed" {
            let _ = increment_daily_stat(&conn, INDEXED_NODES_METRIC, 1);
        }
        if node_supports_stage(&conn, &task.node_id, SEARCH_INDEX_TASK_TYPE).unwrap_or(false) {
            let update = if state == "unsupported" {
                StageUpdate {
                    state: StageState::Skipped,
                    message: Some(message.to_string()),
                    detail: None,
                    error_message: None,
                    retryable: false,
                    attempt: None,
                    started_at: None,
                    finished_at: Some("CURRENT_TIMESTAMP".to_string()),
                }
            } else {
                StageUpdate::succeeded(message)
            };
            let _ = update_stage(&conn, &task.node_id, SEARCH_INDEX_TASK_TYPE, &update);
        }
    }
    emit_status_refresh(db, app_handle, &task.node_id);
}

fn defer_task(db: &Database, app_handle: &AppHandle, task: &BackgroundTask, message: &str) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let outcome = defer_background_task(&conn, task, message);
    drop(conn);
    if matches!(outcome, Ok(BackgroundTaskFailure::Requeued)) {
        apply_index_transition(db, &task.node_id, "pending", None, None);
        if let Ok(conn) = db.connect() {
            if node_supports_stage(&conn, &task.node_id, SEARCH_INDEX_TASK_TYPE).unwrap_or(false) {
                let _ = update_stage(
                    &conn,
                    &task.node_id,
                    SEARCH_INDEX_TASK_TYPE,
                    &StageUpdate::pending("Waiting to index"),
                );
            }
        }
        emit_status_refresh(db, app_handle, &task.node_id);
    }
}

fn fail_task(
    db: &Database,
    app_handle: &AppHandle,
    task: &BackgroundTask,
    message: &str,
    retryable: bool,
) {
    let Ok(conn) = db.connect() else {
        return;
    };
    let outcome = fail_background_task(&conn, task, message, retryable);
    let stage_update = match outcome {
        Ok(BackgroundTaskFailure::Requeued) => {
            apply_index_transition(db, &task.node_id, "pending", None, None);
            StageUpdate::pending("Index retry queued")
        }
        Ok(BackgroundTaskFailure::Failed) => {
            apply_index_transition(db, &task.node_id, "error", None, Some(message.to_string()));
            StageUpdate::failed(message, retryable)
        }
        Ok(BackgroundTaskFailure::Stale) | Err(_) => return,
    };
    if node_supports_stage(&conn, &task.node_id, SEARCH_INDEX_TASK_TYPE).unwrap_or(false) {
        let _ = update_stage(&conn, &task.node_id, SEARCH_INDEX_TASK_TYPE, &stage_update);
    }
    emit_status_refresh(db, app_handle, &task.node_id);
}

fn apply_running(db: &Database, app_handle: &AppHandle, node_id: &str) {
    apply_index_transition(db, node_id, "indexing", None, None);
    if let Ok(conn) = db.connect() {
        if node_supports_stage(&conn, node_id, SEARCH_INDEX_TASK_TYPE).unwrap_or(false) {
            let _ = update_stage(
                &conn,
                node_id,
                SEARCH_INDEX_TASK_TYPE,
                &StageUpdate::running("Indexing"),
            );
        }
    }
    emit_status_refresh(db, app_handle, node_id);
}

fn apply_index_transition(
    db: &Database,
    node_id: &str,
    state: &str,
    indexed_at: Option<String>,
    error: Option<String>,
) {
    let transitions = vec![SearchIndexTransition {
        node_id: node_id.to_string(),
        state: state.to_string(),
        indexed_at,
        error,
    }];
    let _ = apply_search_index_transitions(db, &transitions);
}

fn maybe_enqueue_image_enhancement(
    db: &Database,
    client: &SearchSidecarClient,
    storage_dir: &std::path::Path,
    app_handle: &AppHandle,
    payload: &NodeEvent,
) {
    if payload.force == Some(false) {
        return;
    }
    if payload.kind != "file" || !has_enhancement_extension(&payload.name) {
        return;
    }
    let Ok(conn) = db.connect() else {
        return;
    };
    if enqueue_image_enhancement_for_reindex(&conn, &payload.node_id).is_err() {
        return;
    }
    let emit_handle = app_handle.clone();
    let emitter: VfsEventEmitter = Arc::new(move |event: VfsChangeEvent| {
        let _ = emit_handle.emit(VFS_EVENT_NAME, event);
    });
    spawn_image_enhancement_drain_for_reindex(
        db.clone(),
        Arc::new(client.clone()),
        storage_dir.to_path_buf(),
        emitter,
    );
}

fn emit_status_refresh(db: &Database, app_handle: &AppHandle, node_id: &str) {
    emit_vfs_refresh(app_handle);
    if let Ok(conn) = db.connect() {
        if let Ok(Some(event)) = get_node_status_changed_event(&conn, node_id) {
            let _ = app_handle.emit(NODE_STATUS_CHANGED_EVENT, event);
        }
    }
}

fn emit_vfs_refresh(app_handle: &AppHandle) {
    let _ = app_handle.emit(
        VFS_EVENT_NAME,
        VfsChangeEvent {
            mount_id: String::new(),
            reason: "index-state-changed".to_string(),
            ..Default::default()
        },
    );
}

fn task_force(task: &BackgroundTask) -> bool {
    serde_json::from_str::<Value>(&task.payload_json)
        .ok()
        .and_then(|value| value.get("force").and_then(Value::as_bool))
        .unwrap_or(true)
}

fn is_no_processor_error(error: Option<&str>) -> bool {
    error
        .map(|msg| msg.starts_with("no processor for kind="))
        .unwrap_or(false)
}

fn has_enhancement_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "pdf"]
        .iter()
        .any(|extension| lower.ends_with(&format!(".{extension}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::connection::Database;

    #[test]
    fn task_force_defaults_true_when_payload_is_empty() {
        let task = BackgroundTask {
            id: "task".to_string(),
            node_id: "node".to_string(),
            task_type: SEARCH_INDEX_TASK_TYPE.to_string(),
            generation: 1,
            attempt: 0,
            payload_json: "{}".to_string(),
        };

        assert!(task_force(&task));
    }

    #[test]
    fn enqueue_search_index_task_persists_force_flag() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('11111111-1111-1111-1111-111111111111', 'note', 'Note', 'ready', 0)",
            [],
        )
        .expect("node");
        drop(conn);

        enqueue_search_index_task(&db, "11111111-1111-1111-1111-111111111111", false)
            .expect("enqueue");

        let conn = db.connect().expect("db");
        let payload: String = conn
            .query_row(
                "SELECT payload_json FROM background_tasks WHERE task_type = ?1",
                [SEARCH_INDEX_TASK_TYPE],
                |row| row.get(0),
            )
            .expect("payload");
        assert_eq!(payload, r#"{"force":false}"#);
    }

    #[test]
    fn no_processor_errors_are_unsupported() {
        assert!(is_no_processor_error(Some(
            "no processor for kind='file' path='/x'"
        )));
        assert!(!is_no_processor_error(Some(
            "FileNotFoundError: missing file"
        )));
    }

    #[test]
    fn deferred_index_task_returns_to_queue_without_consuming_attempt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('file-1', 'file', 'a.txt', 'ready', 10)",
            [],
        )
        .expect("node");
        enqueue_background_task(&conn, "file-1", SEARCH_INDEX_TASK_TYPE, None, 3).expect("enqueue");
        let task = claim_next_background_task(&conn, SEARCH_INDEX_TASK_TYPE)
            .expect("claim")
            .expect("task");

        let outcome =
            defer_background_task(&conn, &task, "indexing runner is paused").expect("defer");

        assert_eq!(outcome, BackgroundTaskFailure::Requeued);
        let (status, attempt, last_error): (String, i64, Option<String>) = conn
            .query_row(
                "SELECT status, attempt, last_error
                 FROM background_tasks
                 WHERE node_id = 'file-1' AND task_type = ?1",
                [SEARCH_INDEX_TASK_TYPE],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("task row");
        assert_eq!(status, "queued");
        assert_eq!(attempt, 0);
        assert_eq!(last_error.as_deref(), Some("indexing runner is paused"));
    }

    #[test]
    fn startup_recovery_requeues_deferred_failures_and_resets_node_status() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('folder-1', 'folder', 'Docs', 'error', 0)",
            [],
        )
        .expect("folder");
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
             VALUES ('file-1', 'folder-1', 'file', 'a.txt', 'error', 10)",
            [],
        )
        .expect("file");
        enqueue_background_task(&conn, "file-1", SEARCH_INDEX_TASK_TYPE, None, 3).expect("enqueue");
        conn.execute(
            "
            UPDATE background_tasks
            SET status = 'failed',
                attempt = 3,
                last_error = 'indexing runner is paused',
                completed_at = CURRENT_TIMESTAMP
            WHERE node_id = 'file-1'
              AND task_type = ?1
            ",
            [SEARCH_INDEX_TASK_TYPE],
        )
        .expect("failed task");
        update_stage(
            &conn,
            "file-1",
            SEARCH_INDEX_TASK_TYPE,
            &StageUpdate::failed("Indexing failed", true),
        )
        .expect("failed stage");

        let recovered = recover_deferred_search_index_tasks(&conn).expect("recover");
        drop(conn);
        let transitions = recovered
            .into_iter()
            .map(|node_id| SearchIndexTransition {
                node_id,
                state: "pending".to_string(),
                indexed_at: None,
                error: None,
            })
            .collect::<Vec<_>>();
        apply_search_index_transitions(&db, &transitions).expect("transitions");
        let conn = db.connect().expect("db");

        let (task_status, attempt): (String, i64) = conn
            .query_row(
                "SELECT status, attempt
                 FROM background_tasks
                 WHERE node_id = 'file-1' AND task_type = ?1",
                [SEARCH_INDEX_TASK_TYPE],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("task row");
        assert_eq!(task_status, "queued");
        assert_eq!(attempt, 0);
        let file_state: String = conn
            .query_row("SELECT state FROM nodes WHERE id = 'file-1'", [], |row| {
                row.get(0)
            })
            .expect("file state");
        let folder_state: String = conn
            .query_row("SELECT state FROM nodes WHERE id = 'folder-1'", [], |row| {
                row.get(0)
            })
            .expect("folder state");
        assert_eq!(file_state, "pending");
        assert_eq!(folder_state, "pending");
        let status =
            crate::infrastructure::db::node_status_repository::get_node_status(&conn, "file-1")
                .expect("status")
                .expect("node status");
        assert_eq!(status.overall, "queued");
        assert_eq!(
            status.primary_stage_id.as_deref(),
            Some(SEARCH_INDEX_TASK_TYPE)
        );
    }

    #[test]
    fn startup_resync_queues_unindexed_leaves_but_not_containers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = Database::new(dir.path().join("cognios.db"));
        let conn = db.connect().expect("db");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('mount-1', 'mount', 'Mount', 'pending', 0)",
            [],
        )
        .expect("mount");
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
             VALUES ('folder-1', 'mount-1', 'folder', 'Docs', 'pending', 0)",
            [],
        )
        .expect("folder");
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
             VALUES ('file-1', 'folder-1', 'file', 'a.txt', 'ready', 10)",
            [],
        )
        .expect("file");
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
             VALUES ('note-1', 'folder-1', 'note', 'Note', 'pending', 10)",
            [],
        )
        .expect("note");

        let queued = enqueue_startup_search_index_tasks(&conn).expect("startup queue");

        assert_eq!(queued, 2);
        let task_ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT node_id FROM background_tasks
                     WHERE task_type = ?1
                     ORDER BY node_id",
                )
                .expect("stmt");
            stmt.query_map([SEARCH_INDEX_TASK_TYPE], |row| row.get::<_, String>(0))
                .expect("rows")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("task ids")
        };
        assert_eq!(task_ids, vec!["file-1".to_string(), "note-1".to_string()]);
    }
}
