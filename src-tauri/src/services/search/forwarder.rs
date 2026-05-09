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
//!     * containers (folder / mount) → no path
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

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use rusqlite::OptionalExtension;

use crate::infrastructure::db::connection::Database;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::{
    IndexSnapshotEntry, NodeEvent, NodeEventKind, SearchSidecarClient, SidecarEnvelopeState,
};

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
/// ``forward_node_event`` and the resync ping is the longer-term
/// safety net for any miss.
pub async fn forward_descendant_deletes(
    client: &Arc<SearchSidecarClient>,
    descendant_ids: &[String],
) {
    for id in descendant_ids {
        let payload = NodeEvent {
            event: NodeEventKind::NodeDeleted,
            node_id: id.clone(),
            kind: String::new(),
            name: String::new(),
            absolute_content_path: None,
            mount_id: None,
            created_at: None,
            updated_at: None,
        };
        client.forward_node_event(&payload).await;
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
        // folder / mount — containers, no content to index.
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

// ----- startup resync (diff-first) ----------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResyncSummary {
    pub forwarded: usize,
    pub deleted: usize,
    pub skipped: usize,
}

/// Reconcile the sidecar's index against ``cognios.db``.
///
/// **Diff-first.** For an already-indexed 1000-node workspace this is
/// O(1) HTTP calls + an in-memory diff, instead of O(N) per-node
/// forwards. Naive resync was 500× HTTP roundtrips for an unchanged
/// workspace; this version makes ~1 round-trip per actually-stale
/// node plus one snapshot fetch.
///
/// Sequence:
///
/// 1. ``GET /index/snapshot`` → ``{node_id: {state, modified_at}}``.
/// 2. Walk ``cognios.db`` once for ``(id, updated_at)`` pairs.
/// 3. Diff:
///     - In cognios but not in sidecar → forward (new).
///     - In sidecar with state ≠ indexed → forward (retry).
///     - In both, cognios.updated_at > sidecar.modified_at → forward.
///     - In sidecar but not in cognios → delete.
///     - Otherwise → skip.
/// 4. For each ``forward`` id: build the full ``NodeEvent`` payload via
///    :func:`build_payload` and post.
/// 5. For each ``delete`` id: post ``{event: deleted, node_id}``
///    directly (no DB lookup needed for deletion).
pub async fn resync_all_nodes(
    db: &Database,
    client: &Arc<SearchSidecarClient>,
    storage_dir: &Path,
) -> ResyncSummary {
    // 1. Sidecar's current view.
    let snapshot_env = client.index_snapshot().await;
    let sidecar_view: HashMap<String, IndexSnapshotEntry> = match snapshot_env.state {
        SidecarEnvelopeState::Ready => snapshot_env.data.map(|s| s.nodes).unwrap_or_default(),
        SidecarEnvelopeState::Initialising => {
            log::info!("resync: sidecar still initialising; will retry next cycle");
            return ResyncSummary::default();
        }
        SidecarEnvelopeState::Unavailable => {
            log::warn!(
                "resync: sidecar unavailable ({}); skipping",
                snapshot_env.error.as_deref().unwrap_or("(no detail)")
            );
            return ResyncSummary::default();
        }
    };

    // 2. cognios.db's authoritative (id, updated_at) set.
    let db_view = match list_all_nodes_meta(db) {
        Ok(v) => v,
        Err(err) => {
            log::warn!("resync: list_all_nodes_meta failed: {err}");
            return ResyncSummary::default();
        }
    };

    // 3. Diff.
    let mut to_forward: Vec<String> = Vec::new();
    let mut to_delete: Vec<String> = Vec::new();
    let mut skipped = 0_usize;

    for (node_id, db_meta) in &db_view {
        match sidecar_view.get(node_id) {
            None => to_forward.push(node_id.clone()),
            Some(side) if side.state != "indexed" => to_forward.push(node_id.clone()),
            Some(side) => {
                if newer_than(db_meta.updated_at.as_deref(), side.modified_at.as_deref()) {
                    to_forward.push(node_id.clone());
                } else {
                    skipped += 1;
                }
            }
        }
    }
    for sidecar_id in sidecar_view.keys() {
        if !db_view.contains_key(sidecar_id) {
            to_delete.push(sidecar_id.clone());
        }
    }

    log::info!(
        "resync: {} stale, {} to delete, {} already up-to-date \
         (cognios={} nodes, sidecar={} nodes)",
        to_forward.len(),
        to_delete.len(),
        skipped,
        db_view.len(),
        sidecar_view.len()
    );

    // 4. Forward stale.
    let mut forwarded = 0_usize;
    for node_id in &to_forward {
        let event = VfsChangeEvent {
            mount_id: node_id.clone(),
            reason: "node-created".to_string(),
            ..Default::default()
        };
        if let Some(payload) = build_payload(&event, db, storage_dir) {
            client.forward_node_event(&payload).await;
            forwarded += 1;
        }
    }

    // 5. Delete orphans.
    let mut deleted = 0_usize;
    for node_id in &to_delete {
        let payload = NodeEvent {
            event: NodeEventKind::NodeDeleted,
            node_id: node_id.clone(),
            kind: String::new(),
            name: String::new(),
            absolute_content_path: None,
            mount_id: None,
            created_at: None,
            updated_at: None,
        };
        client.forward_node_event(&payload).await;
        deleted += 1;
    }

    ResyncSummary {
        forwarded,
        deleted,
        skipped,
    }
}

impl Default for ResyncSummary {
    fn default() -> Self {
        Self {
            forwarded: 0,
            deleted: 0,
            skipped: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct NodeMeta {
    updated_at: Option<String>,
}

fn list_all_nodes_meta(db: &Database) -> rusqlite::Result<HashMap<String, NodeMeta>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare("SELECT id, updated_at FROM nodes")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, updated_at) = row?;
        out.insert(id, NodeMeta { updated_at });
    }
    Ok(out)
}

/// String comparison on RFC 3339 / ISO 8601 timestamps is
/// lexicographically equivalent to chronological order *as long as*
/// both values use the same timezone offset and the same precision.
/// SQLite's CURRENT_TIMESTAMP and Python's `datetime.isoformat()` both
/// emit UTC ISO 8601, so this is safe in our pipeline. Treat missing
/// timestamps as "older than any other" — being conservative here means
/// we re-forward ambiguous cases rather than skipping them.
fn newer_than(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(l), Some(r)) => l > r,
        (Some(_), None) => true,
        (None, _) => false,
    }
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
    fn newer_than_handles_missing_timestamps_conservatively() {
        // Both present, left > right → newer
        assert!(newer_than(
            Some("2026-04-27T10:00:00Z"),
            Some("2026-04-27T09:00:00Z")
        ));
        // Both present, equal → not newer (skip)
        assert!(!newer_than(
            Some("2026-04-27T10:00:00Z"),
            Some("2026-04-27T10:00:00Z")
        ));
        // Both present, left < right → not newer
        assert!(!newer_than(
            Some("2026-04-27T08:00:00Z"),
            Some("2026-04-27T10:00:00Z")
        ));
        // Left present, right missing → conservatively newer
        assert!(newer_than(Some("2026-04-27T10:00:00Z"), None));
        // Left missing → not newer (cognios has no signal; trust sidecar)
        assert!(!newer_than(None, Some("2026-04-27T10:00:00Z")));
        assert!(!newer_than(None, None));
    }

    #[test]
    fn list_all_nodes_meta_returns_id_and_updated_at() {
        use crate::infrastructure::db::node_repository::{create_folder, CreateFolderInput};
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let conn = db.connect().expect("db init");
        for name in ["A", "B"] {
            create_folder(
                &conn,
                &CreateFolderInput {
                    name: name.into(),
                    parent_id: None,
                },
            )
            .expect("create folder");
        }
        let meta = list_all_nodes_meta(&db).expect("list");
        assert_eq!(meta.len(), 2);
        for (_, m) in &meta {
            // updated_at is populated by the schema's CURRENT_TIMESTAMP
            // default for newly-created folders.
            assert!(m.updated_at.is_some());
        }
    }

    #[test]
    fn list_all_nodes_meta_empty_on_fresh_db() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cognios.db");
        let db = Database::new(db_path);
        let _ = db.connect().expect("db init");
        let meta = list_all_nodes_meta(&db).expect("list");
        assert!(meta.is_empty());
    }
}
