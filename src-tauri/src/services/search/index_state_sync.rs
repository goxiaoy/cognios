//! Mirror sidecar queue-state transitions into ``cognios.db.nodes.state``.
//!
//! The sidecar owns the indexing queue and is the only process that
//! knows when a node finishes indexing. Without this loop, the
//! ``nodes.state`` column inserted by the mount/note repositories
//! never transitions out of its initial ``ready``/``pending`` value
//! and the explorer's state dot stays at the "pending" tone forever
//! even though the file is fully indexed.
//!
//! The previous architecture polled ``GET /index/snapshot`` every
//! tick — O(corpus) per poll, which is wasteful and gets prohibitive
//! past 50k nodes. This module uses ``GET /index/changes?since=<seq>``
//! instead: cost is proportional to the actual transition rate, not
//! to the corpus size. An idle workspace sends ~50 bytes per poll.
//!
//! Failure modes:
//!
//! - Sidecar unavailable / initialising: keep cursor, retry next tick.
//! - Network blip: same — the cursor only advances on successful apply.
//! - Process restart on the Rust side: cursor starts at 0, so the
//!   first poll returns every transition the sidecar has — same cost
//!   as a snapshot, paid once. After that the steady-state delta-poll
//!   resumes.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter};

use crate::domain::node_status::{StageState, StageUpdate};
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::node_status_repository::{
    get_node_status_changed_event, update_stage, NODE_STATUS_CHANGED_EVENT,
};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::{IndexChangeDto, SearchSidecarClient};
use crate::services::search::supervisor::{SearchSidecarSupervisor, SupervisorState};
use crate::services::search::SidecarEnvelopeState;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const ERROR_BACKOFF: Duration = Duration::from_secs(15);
const POLL_LIMIT: u32 = 1000;
const VFS_EVENT_NAME: &str = "vfs://changed";

/// Apply a batch of sidecar transitions to ``cognios.db.nodes.state``.
///
/// Maps the sidecar's queue states (``pending`` / ``indexing`` /
/// ``indexed`` / ``error``) onto the explorer's ``NodeState`` enum.
/// A transition for a node id that doesn't exist in ``nodes`` is a
/// no-op — the sidecar's queue may legitimately hold ids that were
/// since deleted (the resync flow cleans those up separately).
///
/// Returns the number of rows actually updated. If a node's stored
/// state already matches the incoming state, ``UPDATE`` returns zero
/// rows changed and we don't count it — that lets the caller skip
/// emitting a vfs change event when the batch was a no-op.
pub fn apply_index_changes(
    db: &Database,
    transitions: &[IndexChangeDto],
) -> rusqlite::Result<usize> {
    if transitions.is_empty() {
        return Ok(0);
    }
    let conn = db.connect()?;
    let mut updated = 0_usize;
    let mut containers_to_refresh = HashSet::new();
    for t in transitions {
        let mapped = match t.state.as_str() {
            "indexed" => "indexed",
            // The dispatcher mark_errors any file kind that has no
            // wired processor (``.pdf``, ``.zip``, arbitrary binary,
            // ...). That's not really an error — the file just
            // can't be indexed today. Surface it as a dedicated
            // ``unsupported`` state so the explorer renders the
            // hollow neutral dot rather than the red error tone.
            "error" if is_no_processor_error(t.error.as_deref()) => "unsupported",
            "error" => "error",
            "indexing" => "indexing",
            // Sidecar's ``pending`` maps to our ``pending`` tone via
            // the explorer; write it through so a re-enqueue (file
            // changed on disk, sidecar reset) also flips the dot
            // back from "indexed" to "pending".
            "pending" => "pending",
            other => {
                log::debug!(
                    "skipping unknown sidecar state {other:?} for node {}",
                    t.node_id
                );
                continue;
            }
        };
        let status_update = match t.state.as_str() {
            "indexed" => Some(StageUpdate::succeeded("Indexed")),
            "indexing" => Some(StageUpdate::running("Indexing")),
            "pending" => Some(StageUpdate::pending("Waiting to index")),
            "error" if is_no_processor_error(t.error.as_deref()) => Some(StageUpdate {
                state: StageState::Skipped,
                message: Some("No index processor available".to_string()),
                detail: None,
                error_message: None,
                retryable: false,
                attempt: None,
                started_at: None,
                finished_at: Some("CURRENT_TIMESTAMP".to_string()),
            }),
            "error" => Some(StageUpdate::failed(
                t.error.as_deref().unwrap_or("Indexing failed").to_string(),
                true,
            )),
            _ => None,
        };
        for container_id in lineage_containers(&conn, &t.node_id)? {
            containers_to_refresh.insert(container_id);
        }
        // Only touch rows whose state is actually changing — keeps
        // updated_at stable for unchanged nodes and prevents the vfs
        // event emit below from firing on no-op batches.
        // Container rows are refreshed below from their descendants'
        // states rather than from their own sidecar queue rows.
        let rows = conn.execute(
            "UPDATE nodes SET state = ?2
             WHERE id = ?1 AND state != ?2
               AND kind NOT IN ('folder', 'mount')",
            params![t.node_id, mapped],
        )?;
        if let Some(update) = status_update {
            match update_stage(&conn, &t.node_id, "content.index", &update) {
                Ok(_) => updated += 1,
                Err(error) => {
                    log::debug!(
                        "index-state-sync: skipped node-status update for {}: {error}",
                        t.node_id
                    );
                }
            }
        }
        updated += rows;
    }
    updated += refresh_container_states(&conn, &containers_to_refresh)?;
    Ok(updated)
}

fn lineage_containers(conn: &rusqlite::Connection, node_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "
        WITH RECURSIVE lineage(id, parent_id, kind) AS (
          SELECT id, parent_id, kind
          FROM nodes
          WHERE id = ?1
          UNION ALL
          SELECT n.id, n.parent_id, n.kind
          FROM nodes n
          INNER JOIN lineage l ON n.id = l.parent_id
        )
        SELECT id
        FROM lineage
        WHERE kind IN ('folder', 'mount')
        ",
    )?;
    let rows = stmt.query_map(params![node_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn refresh_container_states(
    conn: &rusqlite::Connection,
    container_ids: &HashSet<String>,
) -> rusqlite::Result<usize> {
    let mut updated = 0_usize;
    for container_id in container_ids {
        let Some(next_state) = aggregate_container_state(conn, container_id)? else {
            continue;
        };
        let rows = conn.execute(
            "
            UPDATE nodes
            SET state = ?2
            WHERE id = ?1
              AND kind IN ('folder', 'mount')
              AND state != 'unavailable'
              AND state != ?2
            ",
            params![container_id, next_state],
        )?;
        updated += rows;
    }
    Ok(updated)
}

fn aggregate_container_state(
    conn: &rusqlite::Connection,
    container_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "
        WITH RECURSIVE descendants(id, kind, state) AS (
          SELECT id, kind, state
          FROM nodes
          WHERE parent_id = ?1
          UNION ALL
          SELECT n.id, n.kind, n.state
          FROM nodes n
          INNER JOIN descendants d ON n.parent_id = d.id
        ),
        leaves AS (
          SELECT state
          FROM descendants
          WHERE kind NOT IN ('folder', 'mount')
        )
        SELECT CASE
          WHEN COUNT(*) = 0 THEN 'ready'
          WHEN SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
          WHEN SUM(CASE WHEN state = 'indexing' THEN 1 ELSE 0 END) > 0 THEN 'indexing'
          WHEN SUM(CASE WHEN state IN ('pending', 'ready') THEN 1 ELSE 0 END) > 0 THEN 'pending'
          ELSE 'indexed'
        END
        FROM leaves
        ",
        params![container_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// True for the dispatcher's "no processor" mark_error message.
/// The runner formats it as ``no processor for kind=<kind> path=...``
/// (see ``sidecar/search_sidecar/index/runner.py``); we match on the
/// stable prefix rather than the full string so a future formatting
/// tweak doesn't silently break the unsupported-state path.
fn is_no_processor_error(error: Option<&str>) -> bool {
    error
        .map(|msg| msg.starts_with("no processor for kind="))
        .unwrap_or(false)
}

/// Long-lived background task. Run once per supervisor lifetime;
/// loops until the runtime tears down. The loop is interrupt-safe
/// (no in-flight transactions across `await`s) so a Tauri shutdown
/// drops it cleanly.
pub async fn run_index_state_sync(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    db: Database,
    app_handle: AppHandle,
) {
    let mut cursor: u64 = 0;
    log::info!(
        "index-state-sync: started and waiting for Running sidecar (cursor=0, poll={:?})",
        POLL_INTERVAL
    );

    loop {
        // ``restart_sidecar`` flips the supervisor through
        // Stopped → Spawning → Running; sleep and re-check rather
        // than exiting so the loop survives the cycle. The only
        // terminal exit is an unretryable Failed (e.g. lock
        // contention with no recovery) — at that point the
        // sidecar isn't coming back without user action.
        match supervisor.state() {
            SupervisorState::Running { .. } => {}
            SupervisorState::Failed {
                retryable: false, ..
            } => {
                log::info!("index-state-sync: supervisor failed terminally; exiting loop");
                return;
            }
            other => {
                log::debug!("index-state-sync: supervisor in {other:?}; waiting for Running");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        }

        let env = client.index_changes(cursor, POLL_LIMIT).await;
        match env.state {
            SidecarEnvelopeState::Ready => {
                if let Some(changes) = env.data {
                    if !changes.transitions.is_empty() {
                        match apply_index_changes(&db, &changes.transitions) {
                            Ok(updated) => {
                                cursor = changes.next_seq.max(cursor);
                                if updated > 0 {
                                    // Per-batch trace only — debug-level
                                    // logging produced 1+ lines every poll
                                    // tick during active indexing runs,
                                    // which buried the actually-actionable
                                    // logs. The cursor + count are still
                                    // available via ``RUST_LOG=trace`` if
                                    // someone needs them.
                                    log::trace!(
                                        "index-state-sync: applied {updated} transition(s), cursor={cursor}"
                                    );
                                    let _ = app_handle.emit(
                                        VFS_EVENT_NAME,
                                        VfsChangeEvent {
                                            mount_id: String::new(),
                                            reason: "index-state-changed".to_string(),
                                            ..Default::default()
                                        },
                                    );
                                    if let Ok(conn) = db.connect() {
                                        for transition in &changes.transitions {
                                            if let Ok(Some(event)) = get_node_status_changed_event(
                                                &conn,
                                                &transition.node_id,
                                            ) {
                                                let _ = app_handle
                                                    .emit(NODE_STATUS_CHANGED_EVENT, event);
                                            }
                                        }
                                    }
                                }
                            }
                            Err(err) => {
                                log::warn!("index-state-sync: write failed: {err}");
                                tokio::time::sleep(ERROR_BACKOFF).await;
                                continue;
                            }
                        }
                    }
                    // If the page was full, drain immediately —
                    // catching up on a cold start shouldn't pay
                    // POLL_INTERVAL per page.
                    if changes.transitions.len() as u32 >= POLL_LIMIT {
                        continue;
                    }
                }
            }
            SidecarEnvelopeState::Initialising => {
                // Sidecar racing back to Ready — short retry.
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            SidecarEnvelopeState::Unavailable => {
                log::debug!(
                    "index-state-sync: sidecar unavailable ({}); backing off",
                    env.error.as_deref().unwrap_or("(no detail)")
                );
                tokio::time::sleep(ERROR_BACKOFF).await;
                continue;
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::connection::Database;

    fn setup_db() -> Database {
        // Use an in-memory file via a temp path so the migrations
        // run normally; in-memory ":memory:" SQLite breaks across
        // connections in some test setups.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        // Hold the tempdir alive for the lifetime of the DB by
        // boxing it into the test scope (Database stores the path
        // by value).
        std::mem::forget(dir);
        Database::new(path)
    }

    fn insert_node(db: &Database, id: &str, state: &str) {
        insert_node_with_kind(db, id, "note", state);
    }

    fn insert_node_with_kind(db: &Database, id: &str, kind: &str, state: &str) {
        insert_node_with_parent_kind(db, id, None, kind, state);
    }

    fn insert_node_with_parent_kind(
        db: &Database,
        id: &str,
        parent_id: Option<&str>,
        kind: &str,
        state: &str,
    ) {
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state)
             VALUES (?1, ?2, ?3, 'n', ?4)",
            params![id, parent_id, kind, state],
        )
        .unwrap();
    }

    fn read_state(db: &Database, id: &str) -> String {
        let conn = db.connect().unwrap();
        conn.query_row(
            "SELECT state FROM nodes WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    }

    fn change(node_id: &str, state: &str, seq: u64) -> IndexChangeDto {
        IndexChangeDto {
            node_id: node_id.to_string(),
            state: state.to_string(),
            indexed_at: None,
            error: None,
            transition_seq: seq,
        }
    }

    fn change_with_error(node_id: &str, state: &str, error: &str, seq: u64) -> IndexChangeDto {
        IndexChangeDto {
            node_id: node_id.to_string(),
            state: state.to_string(),
            indexed_at: None,
            error: Some(error.to_string()),
            transition_seq: seq,
        }
    }

    #[test]
    fn applies_indexed_transition_to_existing_node() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_index_changes(&db, &[change("abc", "indexed", 1)]).unwrap();
        assert_eq!(updated, 1);
        assert_eq!(read_state(&db, "abc"), "indexed");
    }

    #[test]
    fn no_op_when_state_already_matches() {
        let db = setup_db();
        insert_node(&db, "abc", "indexed");
        let updated = apply_index_changes(&db, &[change("abc", "indexed", 1)]).unwrap();
        assert_eq!(updated, 0);
    }

    #[test]
    fn skips_unknown_node_ids_silently() {
        let db = setup_db();
        // No insert — id is not in nodes table.
        let updated = apply_index_changes(&db, &[change("ghost", "indexed", 1)]).unwrap();
        assert_eq!(updated, 0);
    }

    #[test]
    fn skips_unknown_states() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_index_changes(&db, &[change("abc", "weird", 1)]).unwrap();
        assert_eq!(updated, 0);
        assert_eq!(read_state(&db, "abc"), "ready");
    }

    #[test]
    fn batches_apply_in_order() {
        let db = setup_db();
        insert_node(&db, "a", "ready");
        insert_node(&db, "b", "ready");
        insert_node(&db, "c", "ready");
        let updated = apply_index_changes(
            &db,
            &[
                change("a", "indexing", 1),
                change("b", "indexed", 2),
                change("c", "error", 3),
            ],
        )
        .unwrap();
        assert_eq!(updated, 3);
        assert_eq!(read_state(&db, "a"), "indexing");
        assert_eq!(read_state(&db, "b"), "indexed");
        assert_eq!(read_state(&db, "c"), "error");
    }

    #[test]
    fn empty_batch_is_zero_updates() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        assert_eq!(apply_index_changes(&db, &[]).unwrap(), 0);
        assert_eq!(read_state(&db, "abc"), "ready");
    }

    #[test]
    fn container_sidecar_rows_do_not_override_descendant_rollup() {
        // The sidecar may emit transitions for folders/mounts, but
        // containers have no body of their own. Their visible state
        // comes from descendants instead.
        let db = setup_db();
        insert_node_with_kind(&db, "folder-1", "folder", "indexed");
        insert_node_with_parent_kind(&db, "note-1", Some("folder-1"), "note", "indexed");
        let updated = apply_index_changes(
            &db,
            &[
                change("folder-1", "error", 1),
                change("note-1", "indexed", 2),
            ],
        )
        .unwrap();
        assert_eq!(updated, 0);
        assert_eq!(read_state(&db, "folder-1"), "indexed");
    }

    #[test]
    fn container_rollup_follows_pending_descendant() {
        let db = setup_db();
        insert_node_with_kind(&db, "mount-1", "mount", "indexed");
        insert_node_with_parent_kind(&db, "folder-1", Some("mount-1"), "folder", "indexed");
        insert_node_with_parent_kind(&db, "note-1", Some("folder-1"), "note", "indexed");
        insert_node_with_parent_kind(&db, "file-1", Some("folder-1"), "file", "indexed");

        let updated = apply_index_changes(&db, &[change("file-1", "pending", 1)]).unwrap();

        assert_eq!(updated, 3);
        assert_eq!(read_state(&db, "file-1"), "pending");
        assert_eq!(read_state(&db, "folder-1"), "pending");
        assert_eq!(read_state(&db, "mount-1"), "pending");
    }

    #[test]
    fn container_rollup_becomes_indexed_when_descendants_are_settled() {
        let db = setup_db();
        insert_node_with_kind(&db, "mount-1", "mount", "pending");
        insert_node_with_parent_kind(&db, "folder-1", Some("mount-1"), "folder", "pending");
        insert_node_with_parent_kind(&db, "note-1", Some("folder-1"), "note", "indexed");
        insert_node_with_parent_kind(&db, "file-1", Some("folder-1"), "file", "pending");
        insert_node_with_parent_kind(&db, "zip-1", Some("folder-1"), "file", "unsupported");

        let updated = apply_index_changes(&db, &[change("file-1", "indexed", 1)]).unwrap();

        assert_eq!(updated, 3);
        assert_eq!(read_state(&db, "file-1"), "indexed");
        assert_eq!(read_state(&db, "folder-1"), "indexed");
        assert_eq!(read_state(&db, "mount-1"), "indexed");
    }

    #[test]
    fn empty_container_rollup_stays_ready() {
        let db = setup_db();
        insert_node_with_kind(&db, "folder-1", "folder", "ready");

        let updated = apply_index_changes(&db, &[change("folder-1", "indexed", 1)]).unwrap();

        assert_eq!(updated, 0);
        assert_eq!(read_state(&db, "folder-1"), "ready");
    }

    #[test]
    fn no_processor_error_maps_to_unsupported_not_error() {
        // Files the dispatcher can't index (no extractor wired)
        // surface as ``unsupported`` so the explorer renders the
        // neutral hollow dot rather than the alarm-red error tone.
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_index_changes(
            &db,
            &[change_with_error(
                "abc",
                "error",
                "no processor for kind='file' path='/x.zip'",
                1,
            )],
        )
        .unwrap();
        assert_eq!(updated, 1);
        assert_eq!(read_state(&db, "abc"), "unsupported");
    }

    #[test]
    fn other_error_messages_still_map_to_error() {
        // Real failures (extractor crashed, embedder OOM, ...)
        // should still show the red error dot — only the
        // "no processor" prefix is benign.
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_index_changes(
            &db,
            &[change_with_error("abc", "error", "OCR backend crashed", 1)],
        )
        .unwrap();
        assert_eq!(updated, 1);
        assert_eq!(read_state(&db, "abc"), "error");
    }

    #[test]
    fn pending_writeback_resets_indexed_back_to_pending() {
        // Simulates the "file changed on disk → re-enqueue" path:
        // sidecar transitions a previously-indexed node back to
        // pending. The dot must follow.
        let db = setup_db();
        insert_node(&db, "abc", "indexed");
        let updated = apply_index_changes(&db, &[change("abc", "pending", 1)]).unwrap();
        assert_eq!(updated, 1);
        assert_eq!(read_state(&db, "abc"), "pending");
    }
}
