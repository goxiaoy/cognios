//! Translates a [`VfsChangeEvent`] into a [`NodeEvent`] payload the
//! Python sidecar's direct indexing endpoints accept.
//!
//! Only the per-node reasons are forwarded:
//!
//! - ``node-created`` / ``node-saved`` / ``node-renamed`` —
//!   resolve the node's row from ``cognios.db``, derive
//!   ``absolute_content_path`` per kind:
//!     * ``note`` → `<storage>/notes/<id>.md`
//!     * ``url``  → ``urls.html_cache_path``
//!     * ``file`` → ``mounts.absolute_path + nodes.relative_path``
//!     * ``folder`` → ``mounts.absolute_path + nodes.relative_path`` (metadata search)
//!     * ``mount`` → ``mounts.absolute_path`` (metadata search)
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
use std::sync::Arc;

use rusqlite::OptionalExtension;

use crate::infrastructure::db::connection::Database;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::{NodeEvent, NodeEventKind, SearchSidecarClient};

/// True for reasons that name a single node mutation.
fn is_node_reason(reason: &str) -> bool {
    matches!(
        reason,
        "node-created" | "node-saved" | "node-renamed" | "node-deleted" | "url-indexed"
    )
}

/// Fan-out delete forwarding for cascading mutations. The sqlite
/// nodes table uses ``ON DELETE CASCADE`` on ``parent_id``; deleting
/// a Mount or non-empty Folder silently removes every descendant
/// row, but lancedb only knows about the parent's id from the
/// primary ``node-deleted`` event. This pushes a delete payload for
/// each descendant so lancedb stays in sync.
///
/// Fire-and-forget: per-node failures are logged inside
/// ``delete_index_node`` and the Rust-owned task retry path is the
/// longer-term safety net for any miss.
pub async fn forward_descendant_deletes(
    client: &Arc<SearchSidecarClient>,
    descendant_ids: &[String],
) {
    for id in descendant_ids {
        let _ = client.delete_index_node(id).await;
    }
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
            force: None,
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
            log::debug!("forwarder: node {node_id} no longer in cognios.db; skipping forward");
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
        force: if reason == "node-renamed" {
            Some(false)
        } else {
            None
        },
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

fn load_node_row(conn: &rusqlite::Connection, node_id: &str) -> rusqlite::Result<Option<NodeRow>> {
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

fn resolve_path(conn: &rusqlite::Connection, row: &NodeRow, storage_dir: &Path) -> Option<String> {
    match row.kind.as_str() {
        "note" => Some(
            storage_dir
                .join("notes")
                .join(format!("{}.md", row.id))
                .to_string_lossy()
                .into_owned(),
        ),
        "url" => load_url_cache_path(conn, &row.id),
        "file" | "folder" => row
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
        "mount" => load_mount_root(conn, &row.id),
        _ => None,
    }
}

fn load_url_cache_path(conn: &rusqlite::Connection, node_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT html_cache_path FROM urls WHERE node_id = ?1",
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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        // Row not in DB → skip silently.
        assert!(build_payload(&event, &db, dir.path()).is_none());
    }

    #[test]
    fn build_payload_marks_rename_as_metadata_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let conn = db.connect().expect("db init");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('11111111-1111-1111-1111-111111111111', 'note', 'A', 'ready', 0)",
            [],
        )
        .expect("insert node");
        let event = VfsChangeEvent {
            mount_id: "11111111-1111-1111-1111-111111111111".into(),
            reason: "node-renamed".into(),
            ..Default::default()
        };
        let payload = build_payload(&event, &db, dir.path()).expect("payload");
        assert_eq!(payload.force, Some(false));
    }

    #[test]
    fn build_payload_includes_mount_path_for_metadata_search() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let conn = db.connect().expect("db init");
        let mount_root = dir.path().join("20260301-accident");
        std::fs::create_dir_all(&mount_root).expect("mount dir");
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state, size_bytes)
             VALUES ('11111111-1111-1111-1111-111111111111', 'mount', '20260301-accident', 'ready', 0)",
            [],
        )
        .expect("insert mount node");
        conn.execute(
            "INSERT INTO mounts (node_id, absolute_path, ignore_config, is_available)
             VALUES ('11111111-1111-1111-1111-111111111111', ?1, '', 1)",
            [mount_root.to_string_lossy().as_ref()],
        )
        .expect("insert mount");
        let event = VfsChangeEvent {
            mount_id: "11111111-1111-1111-1111-111111111111".into(),
            reason: "node-created".into(),
            ..Default::default()
        };

        let payload = build_payload(&event, &db, dir.path()).expect("payload");

        assert_eq!(
            payload.absolute_content_path.as_deref(),
            Some(mount_root.to_string_lossy().as_ref())
        );
    }
}
