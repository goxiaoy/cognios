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

pub struct CreatedFolder {
    pub node_id: String,
    pub snapshot: ExplorerSnapshotDto,
}

pub fn create_folder(
    conn: &Connection,
    input: &CreateFolderInput,
) -> rusqlite::Result<CreatedFolder> {
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

    let node_id = Uuid::new_v4().to_string();
    conn.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ",
        params![
            node_id,
            input.parent_id,
            NodeKind::Folder.as_str(),
            trimmed_name,
            NodeState::Ready.as_str()
        ],
    )?;

    touch_node_modified_at(conn, input.parent_id.as_deref())?;

    let snapshot = list_snapshot(conn)?;
    Ok(CreatedFolder { node_id, snapshot })
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

        if matches!(node.kind.as_str(), "folder" | "mount") {
            node.size_bytes = node.children.iter().map(|child| child.size_bytes).sum();
            if node.state != NodeState::Unavailable.as_str() {
                node.state = aggregate_container_state(&node.children).to_string();
            }
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

fn aggregate_container_state(children: &[ExplorerNodeDto]) -> &'static str {
    let mut has_leaf = false;
    let mut has_error = false;
    let mut has_indexing = false;
    let mut has_unindexed = false;

    fn visit(
        node: &ExplorerNodeDto,
        has_leaf: &mut bool,
        has_error: &mut bool,
        has_indexing: &mut bool,
        has_unindexed: &mut bool,
    ) {
        if matches!(node.kind.as_str(), "folder" | "mount") {
            for child in &node.children {
                visit(child, has_leaf, has_error, has_indexing, has_unindexed);
            }
            return;
        }

        *has_leaf = true;
        match node.state.as_str() {
            "error" => *has_error = true,
            "indexing" => *has_indexing = true,
            "indexed" | "unsupported" => {}
            _ => *has_unindexed = true,
        }
    }

    for child in children {
        visit(
            child,
            &mut has_leaf,
            &mut has_error,
            &mut has_indexing,
            &mut has_unindexed,
        );
    }

    if !has_leaf {
        "ready"
    } else if has_error {
        "error"
    } else if has_indexing {
        "indexing"
    } else if has_unindexed {
        "pending"
    } else {
        "indexed"
    }
}

pub fn touch_node_modified_at(conn: &Connection, node_id: Option<&str>) -> rusqlite::Result<()> {
    if let Some(node_id) = node_id {
        conn.execute(
            "UPDATE nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [node_id],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, parent_id: Option<&str>, kind: NodeKind, state: NodeState) -> NodeRecord {
        NodeRecord {
            id: id.to_string(),
            parent_id: parent_id.map(ToString::to_string),
            name: id.to_string(),
            kind,
            state,
            created_at: "2026-05-09T00:00:00Z".to_string(),
            updated_at: "2026-05-09T00:00:00Z".to_string(),
            size_bytes: 0,
        }
    }

    #[test]
    fn snapshot_container_state_follows_pending_descendant() {
        let snapshot = build_snapshot(vec![
            record("mount", None, NodeKind::Mount, NodeState::Indexed),
            record(
                "folder",
                Some("mount"),
                NodeKind::Folder,
                NodeState::Indexed,
            ),
            record("note", Some("folder"), NodeKind::Note, NodeState::Pending),
        ]);

        let mount = &snapshot.roots[0];
        let folder = &mount.children[0];
        assert_eq!(folder.state, "pending");
        assert_eq!(mount.state, "pending");
    }

    #[test]
    fn snapshot_container_state_is_indexed_when_descendants_are_settled() {
        let snapshot = build_snapshot(vec![
            record("folder", None, NodeKind::Folder, NodeState::Pending),
            record("note", Some("folder"), NodeKind::Note, NodeState::Indexed),
            record(
                "zip",
                Some("folder"),
                NodeKind::File,
                NodeState::Unsupported,
            ),
        ]);

        assert_eq!(snapshot.roots[0].state, "indexed");
    }

    #[test]
    fn snapshot_empty_container_state_is_ready() {
        let snapshot = build_snapshot(vec![record(
            "folder",
            None,
            NodeKind::Folder,
            NodeState::Indexed,
        )]);

        assert_eq!(snapshot.roots[0].state, "ready");
    }
}
