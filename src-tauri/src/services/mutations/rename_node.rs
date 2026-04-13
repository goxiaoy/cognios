use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::domain::vfs::node::{ExplorerSnapshotDto, NodeKind};
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::mount_repository::reconcile_mount;
use crate::infrastructure::db::node_repository::list_snapshot;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameNodeInput {
    pub node_id: String,
    pub new_name: String,
}

pub fn rename_node(
    conn: &mut Connection,
    input: &RenameNodeInput,
) -> Result<ExplorerSnapshotDto, String> {
    let trimmed_name = input.new_name.trim();
    if trimmed_name.is_empty() {
        return Err("new name must not be empty".into());
    }

    let node = load_node(conn, &input.node_id)?.ok_or_else(|| "node not found".to_string())?;

    match node.kind {
        NodeKind::Folder | NodeKind::Url | NodeKind::Mount => {
            conn.execute(
                "UPDATE nodes SET name = ?2 WHERE id = ?1",
                params![input.node_id, trimmed_name],
            )
            .map_err(|error| error.to_string())?;
        }
        NodeKind::Directory | NodeKind::File => {
            let mount_info = load_mount_info(conn, node.mount_id.as_deref())
                .ok_or_else(|| "mounted node missing mount".to_string())?;
            if mount_info.state == NodeState::Unavailable.as_str() {
                return Err("mounted path is unavailable".into());
            }
            let relative_path = node
                .relative_path
                .ok_or_else(|| "mounted node missing relative path".to_string())?;
            let source_path = PathBuf::from(&mount_info.absolute_path).join(&relative_path);
            let target_path = source_path
                .parent()
                .ok_or_else(|| "mounted path missing parent".to_string())?
                .join(trimmed_name);
            fs::rename(&source_path, &target_path).map_err(|error| error.to_string())?;
            reconcile_mount(conn, mount_info.mount_id.as_str())
                .map_err(|error| error.to_string())?;
        }
    }

    list_snapshot(conn).map_err(|error| error.to_string())
}

#[derive(Debug)]
struct MutationNode {
    kind: NodeKind,
    mount_id: Option<String>,
    relative_path: Option<String>,
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
        SELECT kind, mount_id, relative_path
        FROM nodes
        WHERE id = ?1
        ",
        [node_id],
        |row| {
            Ok(MutationNode {
                kind: NodeKind::from_db(&row.get::<_, String>(0)?),
                mount_id: row.get(1)?,
                relative_path: row.get(2)?,
            })
        },
    )
    .optional()
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
