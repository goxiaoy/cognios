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

use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use tauri::{AppHandle, Emitter};

use crate::infrastructure::db::connection::Database;
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
        // Only touch rows whose state is actually changing — keeps
        // updated_at stable for unchanged nodes and prevents the vfs
        // event emit below from firing on no-op batches.
        //
        // Skip container kinds (folder / mount): the
        // sidecar's dispatcher mark_errors them ("no processor for
        // kind=folder") because they have no body to index, but
        // surfacing that as the explorer's "error" state would
        // paint every folder with a red dot. The frontend already
        // treats containers' ``ready`` as silent, so we just keep
        // them out of the writeback entirely.
        let rows = conn.execute(
            "UPDATE nodes SET state = ?2
             WHERE id = ?1 AND state != ?2
               AND kind NOT IN ('folder', 'mount')",
            params![t.node_id, mapped],
        )?;
        updated += rows;
    }
    Ok(updated)
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
    // Wait for the supervisor to reach Running before issuing the
    // first poll. Bounded so a sidecar that never starts doesn't
    // spin this loop forever (it'll exit and the task ends).
    let mut waited = Duration::ZERO;
    let warmup_step = Duration::from_millis(500);
    while waited < Duration::from_secs(60) {
        if matches!(supervisor.state(), SupervisorState::Running { .. }) {
            break;
        }
        tokio::time::sleep(warmup_step).await;
        waited += warmup_step;
    }
    if !matches!(supervisor.state(), SupervisorState::Running { .. }) {
        log::info!("index-state-sync: sidecar never reached Running; not starting loop");
        return;
    }

    let mut cursor: u64 = 0;
    log::info!(
        "index-state-sync: started (cursor=0, poll={:?})",
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
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state) VALUES (?1, ?2, 'n', ?3)",
            params![id, kind, state],
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
    fn container_kinds_are_never_touched() {
        // The sidecar's dispatcher marks folders as ``error``
        // because there's no processor for them — but we don't
        // want the explorer to paint every folder red. Container
        // kinds (folder / mount) must stay at
        // whatever state Rust set them to.
        let db = setup_db();
        insert_node_with_kind(&db, "folder-1", "folder", "ready");
        insert_node_with_kind(&db, "mount-1", "mount", "ready");
        let updated = apply_index_changes(
            &db,
            &[
                change("folder-1", "error", 1),
                change("mount-1", "error", 2),
            ],
        )
        .unwrap();
        assert_eq!(updated, 0);
        assert_eq!(read_state(&db, "folder-1"), "ready");
        assert_eq!(read_state(&db, "mount-1"), "ready");
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
