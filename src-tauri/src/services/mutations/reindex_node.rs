//! Re-enqueue a node (or every indexable descendant of a container)
//! for a fresh sidecar indexing pass.
//!
//! Mechanism: emit a ``node-saved`` :class:`VfsChangeEvent` for each
//! target node. The forwarder turns that into a ``POST /events/node``
//! whose handler calls ``IndexingQueue.enqueue`` — which resets the
//! queue row to ``pending`` (and clears ``last_error``) regardless
//! of its prior state. The state mirror task then propagates the
//! transition into ``cognios.db.nodes.state`` so the explorer's dot
//! reflects the re-queue.
//!
//! For containers (folder / mount / directory) we walk every
//! descendant and emit one event per leaf; container kinds are
//! skipped because the dispatcher has no processor for them and
//! enqueueing one would just bounce through ``unsupported``.

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;

use crate::domain::vfs::node::NodeKind;
use crate::services::mounts::watcher::VfsChangeEvent;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexNodeInput {
    pub node_id: String,
}

#[derive(Debug)]
pub struct ReindexOutcome {
    /// Number of leaf nodes that had a re-enqueue event emitted.
    /// 1 for a single file/note/url; ``N`` for a container with
    /// ``N`` indexable descendants.
    pub enqueued: usize,
}

pub fn reindex_node(
    conn: &Connection,
    input: &ReindexNodeInput,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<ReindexOutcome, String> {
    let kind = load_node_kind(conn, &input.node_id)?.ok_or_else(|| "node not found".to_string())?;

    let leaf_ids = match kind {
        NodeKind::Folder | NodeKind::Mount | NodeKind::Directory => {
            collect_indexable_descendants(conn, &input.node_id)?
        }
        NodeKind::File | NodeKind::Note | NodeKind::Url => vec![input.node_id.clone()],
    };

    for node_id in &leaf_ids {
        emitter(VfsChangeEvent {
            mount_id: node_id.clone(),
            reason: "node-saved".to_string(),
            ..Default::default()
        });
    }

    Ok(ReindexOutcome {
        enqueued: leaf_ids.len(),
    })
}

fn load_node_kind(conn: &Connection, node_id: &str) -> Result<Option<NodeKind>, String> {
    conn.query_row("SELECT kind FROM nodes WHERE id = ?1", [node_id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|error| error.to_string())
    .map(|opt| opt.map(|s| NodeKind::from_db(&s)))
}

/// Recursive descent that returns only the indexable leaves
/// (file / note / url). Container descendants are filtered out so
/// the emitter doesn't generate one event per folder — those are
/// no-ops on the sidecar side and only add load.
fn collect_indexable_descendants(conn: &Connection, root_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "
            WITH RECURSIVE descendants(id, kind) AS (
                SELECT id, kind FROM nodes WHERE parent_id = ?1
                UNION ALL
                SELECT n.id, n.kind FROM nodes n
                INNER JOIN descendants d ON n.parent_id = d.id
            )
            SELECT id FROM descendants
            WHERE kind IN ('file', 'note', 'url')
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::connection::open_in_memory_database;
    use std::cell::RefCell;

    fn insert(conn: &Connection, id: &str, kind: &str, parent: Option<&str>) {
        conn.execute(
            "INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
             VALUES (?1, ?2, ?3, ?4, 'ready', 0)",
            rusqlite::params![id, parent, kind, id],
        )
        .unwrap();
    }

    fn collect_emits<F>(action: F) -> Vec<VfsChangeEvent>
    where
        F: FnOnce(&dyn Fn(VfsChangeEvent)),
    {
        let events: RefCell<Vec<VfsChangeEvent>> = RefCell::new(Vec::new());
        let emitter = |event: VfsChangeEvent| events.borrow_mut().push(event);
        action(&emitter);
        events.into_inner()
    }

    #[test]
    fn reindex_leaf_emits_one_node_saved_event() {
        let conn = open_in_memory_database().unwrap();
        insert(&conn, "note-1", "note", None);
        let emits = collect_emits(|emitter| {
            let outcome = reindex_node(
                &conn,
                &ReindexNodeInput {
                    node_id: "note-1".into(),
                },
                emitter,
            )
            .unwrap();
            assert_eq!(outcome.enqueued, 1);
        });
        assert_eq!(emits.len(), 1);
        assert_eq!(emits[0].mount_id, "note-1");
        assert_eq!(emits[0].reason, "node-saved");
    }

    #[test]
    fn reindex_folder_fans_out_to_indexable_descendants_only() {
        // folder
        //   ├─ subfolder
        //   │     └─ file-2 (file)
        //   ├─ file-1  (file)
        //   └─ note-1  (note)
        let conn = open_in_memory_database().unwrap();
        insert(&conn, "folder", "folder", None);
        insert(&conn, "subfolder", "folder", Some("folder"));
        insert(&conn, "file-1", "file", Some("folder"));
        insert(&conn, "file-2", "file", Some("subfolder"));
        insert(&conn, "note-1", "note", Some("folder"));

        let emits = collect_emits(|emitter| {
            let outcome = reindex_node(
                &conn,
                &ReindexNodeInput {
                    node_id: "folder".into(),
                },
                emitter,
            )
            .unwrap();
            assert_eq!(outcome.enqueued, 3);
        });
        let ids: std::collections::HashSet<_> = emits.iter().map(|e| e.mount_id.clone()).collect();
        // Only the indexable leaves — the subfolder itself is
        // skipped (containers don't get enqueued).
        assert_eq!(
            ids,
            ["file-1", "file-2", "note-1"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        );
        for e in &emits {
            assert_eq!(e.reason, "node-saved");
        }
    }

    #[test]
    fn reindex_unknown_node_returns_error() {
        let conn = open_in_memory_database().unwrap();
        let emits = collect_emits(|emitter| {
            let err = reindex_node(
                &conn,
                &ReindexNodeInput {
                    node_id: "ghost".into(),
                },
                emitter,
            )
            .unwrap_err();
            assert!(err.contains("not found"));
        });
        assert!(emits.is_empty());
    }

    #[test]
    fn reindex_empty_folder_emits_nothing() {
        // A folder with no descendants is a no-op rather than an
        // error — the caller already had a valid node and we just
        // happen to have nothing to enqueue.
        let conn = open_in_memory_database().unwrap();
        insert(&conn, "folder", "folder", None);
        let emits = collect_emits(|emitter| {
            let outcome = reindex_node(
                &conn,
                &ReindexNodeInput {
                    node_id: "folder".into(),
                },
                emitter,
            )
            .unwrap();
            assert_eq!(outcome.enqueued, 0);
        });
        assert!(emits.is_empty());
    }
}
