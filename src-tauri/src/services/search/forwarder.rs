//! Translates a [`VfsChangeEvent`] into a [`NodeEvent`] payload the
//! Python sidecar's ``POST /events/node`` route accepts.
//!
//! Only the per-node reasons are forwarded:
//!
//! - ``node-created`` / ``node-saved`` / ``node-renamed`` —
//!   resolve the node's row from ``cognios.db``, derive
//!   ``absolute_content_path`` per kind:
//!     * ``note`` → `<storage>/notes/<id>.md`
//!     * ``url``  → ``url_jobs.html_cache_path``
//!     * ``file`` → ``mounts.absolute_path + nodes.relative_path``
//!     * containers (folder / mount / directory) → no path
//! - ``node-deleted`` — forward by id alone; the sidecar's
//!   ``delete_by_node_id`` doesn't need kind/path.
//! - ``url-indexed`` — fired by the URL job runner once the cache
//!   file is ready; same path-resolution as ``node-saved`` for url.
//!
//! Mount-level reasons (``mount-sync``, ``mount-health-sync``, etc.)
//! are dropped — per-file additions inside a mount are caught by the
//! mount watcher's reconcile, which surfaces individual ``node-*``
//! events on the next pass. (The 60-second resync ping is a future
//! safety net for any drift.)
//!
//! This module is intentionally pure logic — no async, no HTTP. It
//! returns ``Option<NodeEvent>`` and the caller (the wrapped emitter
//! in :mod:`crate::lib`) does the fire-and-forget forwarding on a
//! tokio task.

use std::path::Path;

use rusqlite::OptionalExtension;

use crate::infrastructure::db::connection::Database;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::{NodeEvent, NodeEventKind};

/// True for reasons that name a single node mutation.
fn is_node_reason(reason: &str) -> bool {
    matches!(
        reason,
        "node-created" | "node-saved" | "node-renamed" | "node-deleted" | "url-indexed"
    )
}

/// Translate a VFS change into a sidecar payload, or ``None`` if this
/// event isn't one we forward (mount-level events, unknown reasons,
/// or DB lookup failures for non-deletion paths).
pub fn build_payload(
    event: &VfsChangeEvent,
    db: &Database,
    storage_dir: &Path,
) -> Option<NodeEvent> {
    let reason = event.reason.as_str();
    if !is_node_reason(reason) {
        return None;
    }
    // VfsChangeEvent.mount_id is overloaded — for per-node reasons it
    // carries the node id (see plan / Unit 1 wiring).
    let node_id = event.mount_id.clone();
    if node_id.is_empty() {
        return None;
    }

    if reason == "node-deleted" {
        // The row is gone from cognios.db; deletion only needs the id.
        return Some(NodeEvent {
            event: NodeEventKind::NodeDeleted,
            node_id,
            kind: String::new(),
            name: String::new(),
            absolute_content_path: None,
            mount_id: None,
            created_at: None,
            updated_at: None,
        });
    }

    let conn = match db.connect() {
        Ok(c) => c,
        Err(err) => {
            log::warn!("forwarder: db connect failed while resolving {node_id}: {err}");
            return None;
        }
    };

    let row = match load_node_row(&conn, &node_id) {
        Ok(Some(row)) => row,
        Ok(None) => {
            log::debug!(
                "forwarder: node {node_id} no longer in cognios.db; skipping forward"
            );
            return None;
        }
        Err(err) => {
            log::warn!("forwarder: db lookup failed for {node_id}: {err}");
            return None;
        }
    };

    let absolute_content_path = resolve_path(&conn, &row, storage_dir);

    Some(NodeEvent {
        event: NodeEventKind::NodeChanged,
        node_id: row.id,
        kind: row.kind,
        name: row.name,
        absolute_content_path,
        mount_id: row.mount_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[derive(Debug)]
struct NodeRow {
    id: String,
    kind: String,
    name: String,
    mount_id: Option<String>,
    relative_path: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn load_node_row(
    conn: &rusqlite::Connection,
    node_id: &str,
) -> rusqlite::Result<Option<NodeRow>> {
    conn.query_row(
        "
        SELECT id, kind, name, mount_id, relative_path, created_at, updated_at
        FROM nodes
        WHERE id = ?1
        ",
        [node_id],
        |row| {
            Ok(NodeRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                mount_id: row.get(3)?,
                relative_path: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .optional()
}

fn resolve_path(
    conn: &rusqlite::Connection,
    row: &NodeRow,
    storage_dir: &Path,
) -> Option<String> {
    match row.kind.as_str() {
        "note" => Some(
            storage_dir
                .join("notes")
                .join(format!("{}.md", row.id))
                .to_string_lossy()
                .into_owned(),
        ),
        "url" => load_url_cache_path(conn, &row.id),
        "file" => row
            .mount_id
            .as_deref()
            .zip(row.relative_path.as_deref())
            .and_then(|(mount_id, relative)| {
                load_mount_root(conn, mount_id).map(|root| {
                    Path::new(&root)
                        .join(relative)
                        .to_string_lossy()
                        .into_owned()
                })
            }),
        // folder / mount / directory — containers, no content to index.
        _ => None,
    }
}

fn load_url_cache_path(conn: &rusqlite::Connection, node_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT html_cache_path FROM url_jobs WHERE node_id = ?1",
        [node_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

fn load_mount_root(conn: &rusqlite::Connection, mount_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT absolute_path FROM mounts WHERE node_id = ?1",
        [mount_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_mount_level_reasons() {
        assert!(!is_node_reason("mount-sync"));
        assert!(!is_node_reason("mount-health-sync"));
        assert!(!is_node_reason("mount-available"));
    }

    #[test]
    fn recognises_per_node_reasons() {
        for reason in [
            "node-created",
            "node-saved",
            "node-renamed",
            "node-deleted",
            "url-indexed",
        ] {
            assert!(is_node_reason(reason), "should accept {reason}");
        }
    }

    #[test]
    fn build_payload_returns_none_for_unknown_reason() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        // Initialise schema by opening a connection through the
        // standard Database::connect — that runs migrations.
        let db = Database::new(db_path);
        let _ = db.connect().expect("db init");
        let event = VfsChangeEvent {
            mount_id: "anything".into(),
            reason: "mount-sync".into(),
        };
        assert!(build_payload(&event, &db, dir.path()).is_none());
    }

    #[test]
    fn build_payload_for_deleted_returns_id_only_payload() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let _ = db.connect().expect("db init");
        let event = VfsChangeEvent {
            mount_id: "abc-123".into(),
            reason: "node-deleted".into(),
        };
        let payload = build_payload(&event, &db, dir.path()).expect("payload");
        assert!(matches!(payload.event, NodeEventKind::NodeDeleted));
        assert_eq!(payload.node_id, "abc-123");
        assert!(payload.absolute_content_path.is_none());
        assert!(payload.kind.is_empty());
    }

    #[test]
    fn build_payload_skips_when_node_missing_for_change_event() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let _ = db.connect().expect("db init");
        let event = VfsChangeEvent {
            mount_id: "ghost".into(),
            reason: "node-created".into(),
        };
        // Row not in DB → skip silently.
        assert!(build_payload(&event, &db, dir.path()).is_none());
    }
}
