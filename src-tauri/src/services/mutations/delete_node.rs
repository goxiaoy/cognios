use std::fs;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;

use crate::domain::vfs::node::{ExplorerSnapshotDto, NodeKind};
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::mount_repository::reconcile_mount;
use crate::infrastructure::db::node_repository::{list_snapshot, touch_node_modified_at};
use crate::infrastructure::db::url_repository::delete_url_artifacts;
use crate::services::mounts::watcher::VfsChangeEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNodeInput {
    pub node_id: String,
    pub cascade: Option<bool>,
}

pub fn delete_node(
    conn: &mut Connection,
    input: &DeleteNodeInput,
    notes_dir: &std::path::Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<ExplorerSnapshotDto, String> {
    let node = load_node(conn, &input.node_id)?.ok_or_else(|| "node not found".to_string())?;

    // Walk the descendants up front so the sidecar can clean up its
    // index for every cascaded id, not just the parent.
    // ``ON DELETE CASCADE`` on the nodes table silently removes the
    // children sqlite-side; without this list, lancedb keeps every
    // chunk under those children's ids forever.
    let descendant_ids = collect_descendant_ids(conn, &input.node_id)?;

    match node.kind {
        NodeKind::Folder if node.is_mounted_path() => {
            delete_mounted_path(conn, &node)?;
        }
        NodeKind::Folder => {
            let child_count = child_count(conn, &input.node_id)?;
            if child_count > 0 && !input.cascade.unwrap_or(false) {
                return Err("folder not empty; retry with cascade".into());
            }
            conn.execute("DELETE FROM nodes WHERE id = ?1", [&input.node_id])
                .map_err(|error| error.to_string())?;
            touch_node_modified_at(conn, node.parent_id.as_deref())
                .map_err(|error| error.to_string())?;
        }
        NodeKind::Url => {
            delete_url_artifacts(conn, &input.node_id).map_err(|error| error.to_string())?;
            conn.execute("DELETE FROM nodes WHERE id = ?1", [&input.node_id])
                .map_err(|error| error.to_string())?;
            touch_node_modified_at(conn, node.parent_id.as_deref())
                .map_err(|error| error.to_string())?;
        }
        NodeKind::Mount => {
            conn.execute("DELETE FROM nodes WHERE id = ?1", [&input.node_id])
                .map_err(|error| error.to_string())?;
            touch_node_modified_at(conn, node.parent_id.as_deref())
                .map_err(|error| error.to_string())?;
        }
        NodeKind::Note => {
            let note_path = notes_dir.join(format!("{}.md", input.node_id));
            if note_path.exists() {
                fs::remove_file(&note_path).map_err(|error| error.to_string())?;
            }
            if let Some(storage_dir) = notes_dir.parent() {
                let voice_note_dir = storage_dir.join("voice-notes").join(&input.node_id);
                if voice_note_dir.exists() {
                    fs::remove_dir_all(&voice_note_dir).map_err(|error| error.to_string())?;
                }
            }
            conn.execute("DELETE FROM nodes WHERE id = ?1", [&input.node_id])
                .map_err(|error| error.to_string())?;
            touch_node_modified_at(conn, node.parent_id.as_deref())
                .map_err(|error| error.to_string())?;
        }
        NodeKind::File => delete_mounted_path(conn, &node)?,
    }

    let snapshot = list_snapshot(conn).map_err(|error| error.to_string())?;
    emitter(VfsChangeEvent {
        mount_id: input.node_id.clone(),
        reason: "node-deleted".to_string(),
        descendant_ids,
    });
    Ok(snapshot)
}

/// Recursively collect every descendant id of `root_id`, excluding
/// the root itself. Empty for leaf nodes (notes, urls, files).
fn collect_descendant_ids(conn: &Connection, root_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM nodes WHERE parent_id = ?1
                UNION ALL
                SELECT n.id FROM nodes n
                INNER JOIN descendants d ON n.parent_id = d.id
            )
            SELECT id FROM descendants
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([root_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

#[derive(Debug)]
struct MutationNode {
    kind: NodeKind,
    parent_id: Option<String>,
    mount_id: Option<String>,
    relative_path: Option<String>,
}

impl MutationNode {
    fn is_mounted_path(&self) -> bool {
        self.mount_id.is_some() && self.relative_path.is_some()
    }
}

#[derive(Debug)]
struct MountInfo {
    mount_id: String,
    absolute_path: String,
    state: String,
}

fn load_node(conn: &Connection, node_id: &str) -> Result<Option<MutationNode>, String> {
    conn.query_row(
        "
        SELECT kind, parent_id, mount_id, relative_path
        FROM nodes
        WHERE id = ?1
        ",
        [node_id],
        |row| {
            Ok(MutationNode {
                kind: NodeKind::from_db(&row.get::<_, String>(0)?),
                parent_id: row.get(1)?,
                mount_id: row.get(2)?,
                relative_path: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn child_count(conn: &Connection, node_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE parent_id = ?1",
        [node_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn load_mount_info(conn: &Connection, mount_id: Option<&str>) -> Option<MountInfo> {
    let mount_id = mount_id?;
    conn.query_row(
        "
        SELECT mounts.node_id, mounts.absolute_path, nodes.state
        FROM mounts
        INNER JOIN nodes ON nodes.id = mounts.node_id
        WHERE mounts.node_id = ?1
        ",
        [mount_id],
        |row| {
            Ok(MountInfo {
                mount_id: row.get(0)?,
                absolute_path: row.get(1)?,
                state: row.get(2)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn delete_mounted_path(conn: &mut Connection, node: &MutationNode) -> Result<(), String> {
    let mount_info = load_mount_info(conn, node.mount_id.as_deref())
        .ok_or_else(|| "mounted node missing mount".to_string())?;
    if mount_info.state == NodeState::Unavailable.as_str() {
        return Err("mounted path is unavailable".into());
    }
    let relative_path = node
        .relative_path
        .as_deref()
        .ok_or_else(|| "mounted node missing relative path".to_string())?;
    let source_path = PathBuf::from(&mount_info.absolute_path).join(relative_path);
    if node.kind == NodeKind::Folder {
        fs::remove_dir_all(&source_path).map_err(|error| error.to_string())?;
    } else {
        fs::remove_file(&source_path).map_err(|error| error.to_string())?;
    }
    reconcile_mount(conn, mount_info.mount_id.as_str()).map_err(|error| error.to_string())?;
    Ok(())
}
