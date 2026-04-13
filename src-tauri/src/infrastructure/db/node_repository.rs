use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Deserialize;
use uuid::Uuid;

use crate::domain::vfs::node::{ExplorerNodeDto, ExplorerSnapshotDto, NodeKind, NodeRecord};
use crate::domain::vfs::state::NodeState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderInput {
    pub name: String,
    pub parent_id: Option<String>,
}

pub fn list_snapshot(conn: &Connection) -> rusqlite::Result<ExplorerSnapshotDto> {
    let mut stmt = conn.prepare(
        "
        SELECT id, parent_id, name, kind, state, created_at, updated_at, size_bytes
        FROM nodes
        ORDER BY parent_id IS NOT NULL, name COLLATE NOCASE ASC
        ",
    )?;

    let records = stmt
        .query_map([], |row| {
            Ok(NodeRecord {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                kind: NodeKind::from_db(&row.get::<_, String>(3)?),
                state: NodeState::from_db(&row.get::<_, String>(4)?),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                size_bytes: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(build_snapshot(records))
}

pub fn create_folder(
    conn: &Connection,
    input: &CreateFolderInput,
) -> rusqlite::Result<ExplorerSnapshotDto> {
    let trimmed_name = input.name.trim();
    if trimmed_name.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "folder name must not be empty".into(),
        ));
    }

    if let Some(parent_id) = &input.parent_id {
        let mut stmt = conn.prepare("SELECT 1 FROM nodes WHERE id = ?1 LIMIT 1")?;
        let parent_exists = stmt.exists([parent_id])?;
        if !parent_exists {
            return Err(rusqlite::Error::InvalidParameterName(
                "parent folder does not exist".into(),
            ));
        }
    }

    conn.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ",
        params![
            Uuid::new_v4().to_string(),
            input.parent_id,
            NodeKind::Folder.as_str(),
            trimmed_name,
            NodeState::Ready.as_str()
        ],
    )?;

    touch_node_modified_at(conn, input.parent_id.as_deref())?;

    list_snapshot(conn)
}

fn build_snapshot(records: Vec<NodeRecord>) -> ExplorerSnapshotDto {
    let mut by_id: HashMap<String, ExplorerNodeDto> = records
        .iter()
        .cloned()
        .map(ExplorerNodeDto::from)
        .map(|node| (node.id.clone(), node))
        .collect();

    let mut child_ids_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut root_ids = Vec::new();

    for record in &records {
        if let Some(parent_id) = &record.parent_id {
            child_ids_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(record.id.clone());
        } else {
            root_ids.push(record.id.clone());
        }
    }

    fn assemble(
        node_id: &str,
        by_id: &mut HashMap<String, ExplorerNodeDto>,
        child_ids_by_parent: &HashMap<String, Vec<String>>,
    ) -> ExplorerNodeDto {
        let mut node = by_id
            .remove(node_id)
            .unwrap_or_else(|| panic!("missing node {node_id}"));

        if let Some(child_ids) = child_ids_by_parent.get(node_id) {
            node.children = child_ids
                .iter()
                .map(|child_id| assemble(child_id, by_id, child_ids_by_parent))
                .collect();
        }

        if matches!(node.kind.as_str(), "folder" | "mount" | "directory") {
            node.size_bytes = node.children.iter().map(|child| child.size_bytes).sum();
        }

        node
    }

    ExplorerSnapshotDto {
        roots: root_ids
            .iter()
            .map(|root_id| assemble(root_id, &mut by_id, &child_ids_by_parent))
            .collect(),
    }
}

pub fn touch_node_modified_at(
    conn: &Connection,
    node_id: Option<&str>,
) -> rusqlite::Result<()> {
    if let Some(node_id) = node_id {
        conn.execute(
            "UPDATE nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [node_id],
        )?;
    }

    Ok(())
}
