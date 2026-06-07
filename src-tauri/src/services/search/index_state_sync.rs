//! Apply Rust-owned indexing task outcomes into ``cognios.db``.
//!
//! The durable task source now lives in Rust's ``background_tasks``.
//! This module keeps the local ``nodes.state`` rollups and
//! ``node_statuses`` timeline updates in one place so search indexing
//! workers can update UI-visible state without relying on a sidecar
//! queue database.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use crate::domain::node_status::{StageState, StageUpdate};
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::node_status_repository::{node_supports_stage, update_stage};

/// One local search-index state transition produced by Rust-owned workers.
#[derive(Debug, Clone)]
pub struct SearchIndexTransition {
    pub node_id: String,
    pub state: String,
    pub indexed_at: Option<String>,
    pub error: Option<String>,
}

/// Apply a batch of search-index transitions to ``cognios.db.nodes.state``.
///
/// Maps task states (``pending`` / ``indexing`` / ``indexed`` /
/// ``error``) onto the explorer's ``NodeState`` enum.
/// A transition for a node id that doesn't exist in ``nodes`` is a
/// no-op because the node may have been deleted before the async task
/// result arrived.
///
/// Returns the number of visible changes worth emitting to the UI:
/// ``nodes.state`` row changes, container rollups, and node-status
/// stage changes. A transition can still be visible even when
/// the coarse ``nodes.state`` value already matches, because the
/// per-node status timeline may have progressed.
pub fn apply_search_index_transitions(
    db: &Database,
    transitions: &[SearchIndexTransition],
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
            // ``pending`` maps to our ``pending`` tone via
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
            if node_supports_stage(&conn, &t.node_id, "search.index")? {
                match update_stage(&conn, &t.node_id, "search.index", &update) {
                    Ok(_) => updated += 1,
                    Err(error) => {
                        log::debug!(
                            "index-state-sync: skipped node-status update for {}: {error}",
                            t.node_id
                        );
                    }
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

    fn count_status_rows(db: &Database, id: &str) -> i64 {
        let conn = db.connect().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM node_statuses WHERE node_id = ?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
    }

    fn change(node_id: &str, state: &str) -> SearchIndexTransition {
        SearchIndexTransition {
            node_id: node_id.to_string(),
            state: state.to_string(),
            indexed_at: None,
            error: None,
        }
    }

    fn change_with_error(node_id: &str, state: &str, error: &str) -> SearchIndexTransition {
        SearchIndexTransition {
            node_id: node_id.to_string(),
            state: state.to_string(),
            indexed_at: None,
            error: Some(error.to_string()),
        }
    }

    #[test]
    fn applies_indexed_transition_to_existing_node() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_search_index_transitions(&db, &[change("abc", "indexed")]).unwrap();
        assert_eq!(updated, 2);
        assert_eq!(read_state(&db, "abc"), "indexed");
    }

    #[test]
    fn stage_update_counts_when_state_already_matches() {
        let db = setup_db();
        insert_node(&db, "abc", "indexed");
        let updated = apply_search_index_transitions(&db, &[change("abc", "indexed")]).unwrap();
        assert_eq!(updated, 1);
    }

    #[test]
    fn skips_unknown_node_ids_silently() {
        let db = setup_db();
        // No insert — id is not in nodes table.
        let updated = apply_search_index_transitions(&db, &[change("ghost", "indexed")]).unwrap();
        assert_eq!(updated, 0);
    }

    #[test]
    fn skips_unknown_states() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_search_index_transitions(&db, &[change("abc", "weird")]).unwrap();
        assert_eq!(updated, 0);
        assert_eq!(read_state(&db, "abc"), "ready");
    }

    #[test]
    fn batches_apply_in_order() {
        let db = setup_db();
        insert_node(&db, "a", "ready");
        insert_node(&db, "b", "ready");
        insert_node(&db, "c", "ready");
        let updated = apply_search_index_transitions(
            &db,
            &[
                change("a", "indexing"),
                change("b", "indexed"),
                change("c", "error"),
            ],
        )
        .unwrap();
        assert_eq!(updated, 6);
        assert_eq!(read_state(&db, "a"), "indexing");
        assert_eq!(read_state(&db, "b"), "indexed");
        assert_eq!(read_state(&db, "c"), "error");
    }

    #[test]
    fn empty_batch_is_zero_updates() {
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        assert_eq!(apply_search_index_transitions(&db, &[]).unwrap(), 0);
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
        let updated = apply_search_index_transitions(
            &db,
            &[change("folder-1", "error"), change("note-1", "indexed")],
        )
        .unwrap();
        assert_eq!(updated, 1);
        assert_eq!(read_state(&db, "folder-1"), "indexed");
    }

    #[test]
    fn container_sidecar_rows_do_not_create_node_status_rows() {
        let db = setup_db();
        insert_node_with_kind(&db, "folder-1", "folder", "ready");

        let updated =
            apply_search_index_transitions(&db, &[change("folder-1", "indexed")]).unwrap();

        assert_eq!(updated, 0);
        assert_eq!(count_status_rows(&db, "folder-1"), 0);
    }

    #[test]
    fn container_rollup_follows_pending_descendant() {
        let db = setup_db();
        insert_node_with_kind(&db, "mount-1", "mount", "indexed");
        insert_node_with_parent_kind(&db, "folder-1", Some("mount-1"), "folder", "indexed");
        insert_node_with_parent_kind(&db, "note-1", Some("folder-1"), "note", "indexed");
        insert_node_with_parent_kind(&db, "file-1", Some("folder-1"), "file", "indexed");

        let updated = apply_search_index_transitions(&db, &[change("file-1", "pending")]).unwrap();

        assert_eq!(updated, 4);
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

        let updated = apply_search_index_transitions(&db, &[change("file-1", "indexed")]).unwrap();

        assert_eq!(updated, 4);
        assert_eq!(read_state(&db, "file-1"), "indexed");
        assert_eq!(read_state(&db, "folder-1"), "indexed");
        assert_eq!(read_state(&db, "mount-1"), "indexed");
    }

    #[test]
    fn empty_container_rollup_stays_ready() {
        let db = setup_db();
        insert_node_with_kind(&db, "folder-1", "folder", "ready");

        let updated =
            apply_search_index_transitions(&db, &[change("folder-1", "indexed")]).unwrap();

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
        let updated = apply_search_index_transitions(
            &db,
            &[change_with_error(
                "abc",
                "error",
                "no processor for kind='file' path='/x.zip'",
            )],
        )
        .unwrap();
        assert_eq!(updated, 2);
        assert_eq!(read_state(&db, "abc"), "unsupported");
    }

    #[test]
    fn other_error_messages_still_map_to_error() {
        // Real failures (extractor crashed, embedder OOM, ...)
        // should still show the red error dot — only the
        // "no processor" prefix is benign.
        let db = setup_db();
        insert_node(&db, "abc", "ready");
        let updated = apply_search_index_transitions(
            &db,
            &[change_with_error("abc", "error", "OCR backend crashed")],
        )
        .unwrap();
        assert_eq!(updated, 2);
        assert_eq!(read_state(&db, "abc"), "error");
    }

    #[test]
    fn pending_writeback_resets_indexed_back_to_pending() {
        // Simulates the "file changed on disk → re-enqueue" path:
        // sidecar transitions a previously-indexed node back to
        // pending. The dot must follow.
        let db = setup_db();
        insert_node(&db, "abc", "indexed");
        let updated = apply_search_index_transitions(&db, &[change("abc", "pending")]).unwrap();
        assert_eq!(updated, 2);
        assert_eq!(read_state(&db, "abc"), "pending");
    }
}
