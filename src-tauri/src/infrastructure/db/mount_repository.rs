use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::domain::vfs::node::NodeKind;
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::node_repository::{list_snapshot, touch_node_modified_at};
use crate::services::mounts::ignore_config::DEFAULT_MOUNT_IGNORE_CONFIG;
use crate::services::mounts::scanner::{
    mount_display_name, normalize_mount_path, scan_mount, ScannedMountEntry,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMountInput {
    pub path: String,
    pub parent_id: Option<String>,
    pub ignore_config: Option<String>,
}

#[derive(Debug)]
pub struct ReconcileMountOutcome {
    pub mount_id: String,
    pub is_available: bool,
    pub changed: bool,
    /// Node IDs that did not exist on the previous reconcile pass —
    /// the caller fires ``node-created`` for each so the forwarder
    /// hands them off to the sidecar's indexer.
    pub new_descendant_ids: Vec<String>,
}

#[derive(Debug)]
pub struct CreatedMount {
    pub mount_id: String,
    pub absolute_path: String,
    pub snapshot: ExplorerSnapshotDto,
    /// Every descendant node persisted by the initial scan. The
    /// caller emits ``node-created`` for each so the sidecar's
    /// indexer queues them up — without this fan-out the mount
    /// shows up in the tree but never gets indexed.
    pub new_descendant_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingMount {
    pub node_id: String,
    pub name: String,
    pub absolute_path: String,
}

#[derive(Clone, Debug)]
pub struct MountWatchConfig {
    pub mount_id: String,
    pub absolute_path: String,
}

pub fn create_mount(
    conn: &mut Connection,
    input: &CreateMountInput,
) -> rusqlite::Result<CreatedMount> {
    validate_parent(conn, input.parent_id.as_deref())?;

    let normalized_path =
        normalize_mount_path(&input.path).map_err(rusqlite::Error::InvalidParameterName)?;
    let ignore_config = normalize_ignore_config(input.ignore_config.as_deref());
    let scanned_entries = scan_mount(&normalized_path, &ignore_config)
        .map_err(rusqlite::Error::InvalidParameterName)?;
    let mount_id = Uuid::new_v4().to_string();
    let mount_name = mount_display_name(&normalized_path);

    let tx = conn.transaction()?;
    tx.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ",
        params![
            mount_id,
            input.parent_id,
            NodeKind::Mount.as_str(),
            mount_name,
            NodeState::Ready.as_str()
        ],
    )?;
    tx.execute(
        "
        INSERT INTO mounts (node_id, absolute_path, ignore_config, is_available)
        VALUES (?1, ?2, ?3, 1)
        ",
        params![mount_id, normalized_path.to_string_lossy(), ignore_config],
    )?;
    let new_descendant_ids =
        insert_scanned_entries(&tx, &mount_id, &scanned_entries, &HashMap::new())?;
    tx.commit()?;
    touch_node_modified_at(conn, input.parent_id.as_deref())?;

    let snapshot = list_snapshot(conn)?;

    Ok(CreatedMount {
        mount_id,
        absolute_path: normalized_path.to_string_lossy().into_owned(),
        snapshot,
        new_descendant_ids,
    })
}

pub fn list_mount_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT node_id FROM mounts ORDER BY node_id")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn list_mount_watch_configs(conn: &Connection) -> rusqlite::Result<Vec<MountWatchConfig>> {
    let mut stmt = conn.prepare(
        "
        SELECT node_id, absolute_path
        FROM mounts
        ORDER BY node_id
        ",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(MountWatchConfig {
            mount_id: row.get(0)?,
            absolute_path: row.get(1)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn list_existing_mounts(conn: &Connection) -> rusqlite::Result<Vec<ExistingMount>> {
    let mut stmt = conn.prepare(
        "
        SELECT mounts.node_id, nodes.name, mounts.absolute_path
        FROM mounts
        INNER JOIN nodes ON nodes.id = mounts.node_id
        ORDER BY nodes.name, mounts.absolute_path
        ",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ExistingMount {
            node_id: row.get(0)?,
            name: row.get(1)?,
            absolute_path: row.get(2)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn find_existing_mount_by_absolute_path(
    conn: &Connection,
    absolute_path: &str,
) -> rusqlite::Result<Option<ExistingMount>> {
    let mut stmt = conn.prepare(
        "
        SELECT mounts.node_id, nodes.name, mounts.absolute_path
        FROM mounts
        INNER JOIN nodes ON nodes.id = mounts.node_id
        WHERE mounts.absolute_path = ?1
        LIMIT 1
        ",
    )?;
    let mut rows = stmt.query([absolute_path])?;

    if let Some(row) = rows.next()? {
        return Ok(Some(ExistingMount {
            node_id: row.get(0)?,
            name: row.get(1)?,
            absolute_path: row.get(2)?,
        }));
    }

    Ok(None)
}

/// Describes a nested-mount conflict: the proposed path either lives
/// inside an existing mount, or contains an existing mount as a
/// descendant. Both directions are rejected because either case
/// makes the watcher + reconcile loop write conflicting rows for
/// the same files (one set tagged with the outer mount_id, one with
/// the inner — and the outer's reconcile DELETE-then-INSERT would
/// either shadow the inner's nodes or wipe them mid-cycle).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedMountConflict {
    pub existing_node_id: String,
    pub existing_name: String,
    pub existing_path: String,
    /// ``"inside"`` — the new path is inside ``existing_path``.
    /// ``"contains"`` — the new path contains ``existing_path``.
    pub direction: NestedMountDirection,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NestedMountDirection {
    /// The proposed path is inside an existing mount.
    Inside,
    /// The proposed path is an ancestor of an existing mount.
    Contains,
}

/// Returns the first existing mount that conflicts with ``candidate``
/// in the nesting sense (ancestor or descendant). The exact-path
/// duplicate is **not** treated as a nesting conflict — callers
/// should run :func:`find_existing_mount_by_absolute_path` first
/// for that case so the surfaced error is unambiguous.
pub fn find_nested_mount_conflict(
    conn: &Connection,
    candidate: &std::path::Path,
) -> rusqlite::Result<Option<NestedMountConflict>> {
    let mut stmt = conn.prepare(
        "
        SELECT mounts.node_id, nodes.name, mounts.absolute_path
        FROM mounts
        INNER JOIN nodes ON nodes.id = mounts.node_id
        ",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (node_id, name, path) = row?;
        let existing = std::path::Path::new(&path);
        if existing == candidate {
            // Caller surfaces this via the dedicated duplicate
            // route — skip here so we don't double-flag.
            continue;
        }
        if candidate.starts_with(existing) {
            return Ok(Some(NestedMountConflict {
                existing_node_id: node_id,
                existing_name: name,
                existing_path: path,
                direction: NestedMountDirection::Inside,
            }));
        }
        if existing.starts_with(candidate) {
            return Ok(Some(NestedMountConflict {
                existing_node_id: node_id,
                existing_name: name,
                existing_path: path,
                direction: NestedMountDirection::Contains,
            }));
        }
    }
    Ok(None)
}

pub fn reconcile_mount(
    conn: &mut Connection,
    mount_id: &str,
) -> rusqlite::Result<ReconcileMountOutcome> {
    let mount = get_mount_record(conn, mount_id)?;
    let normalized_path = std::path::PathBuf::from(&mount.absolute_path);

    if !normalized_path.is_dir() {
        let changed = mount.is_available || mount.state != NodeState::Unavailable.as_str();
        if changed {
            conn.execute(
                "UPDATE nodes SET state = ?2 WHERE id = ?1",
                params![mount_id, NodeState::Unavailable.as_str()],
            )?;
            conn.execute(
                "UPDATE mounts SET is_available = 0 WHERE node_id = ?1",
                [mount_id],
            )?;
        }

        return Ok(ReconcileMountOutcome {
            mount_id: mount_id.to_string(),
            is_available: false,
            changed,
            new_descendant_ids: Vec::new(),
        });
    }

    let scanned_entries = scan_mount(&normalized_path, &mount.ignore_config)
        .map_err(rusqlite::Error::InvalidParameterName)?;
    let existing_entries = load_mount_entries(conn, mount_id)?;
    let mount_name = mount_display_name(&normalized_path);
    let changed = !mount.is_available
        || mount.state == NodeState::Unavailable.as_str()
        || mount.name != mount_name
        || existing_entries
            .iter()
            .map(PersistedMountEntry::as_scanned_entry)
            .collect::<Vec<_>>()
            != scanned_entries;

    if !changed {
        return Ok(ReconcileMountOutcome {
            mount_id: mount_id.to_string(),
            is_available: true,
            changed: false,
            new_descendant_ids: Vec::new(),
        });
    }

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM nodes WHERE mount_id = ?1", [mount_id])?;
    tx.execute(
        "UPDATE nodes SET state = ?2, name = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![mount_id, NodeState::Ready.as_str(), mount_name],
    )?;
    tx.execute(
        "UPDATE mounts SET is_available = 1 WHERE node_id = ?1",
        [mount_id],
    )?;
    let existing_ids_by_relative_path = existing_entries
        .iter()
        .map(|entry| (entry.relative_path.clone(), entry.id.clone()))
        .collect::<HashMap<_, _>>();
    let new_descendant_ids = insert_scanned_entries(
        &tx,
        mount_id,
        &scanned_entries,
        &existing_ids_by_relative_path,
    )?;
    tx.commit()?;

    Ok(ReconcileMountOutcome {
        mount_id: mount_id.to_string(),
        is_available: true,
        changed: true,
        new_descendant_ids,
    })
}

#[derive(Debug)]
struct MountRecord {
    absolute_path: String,
    ignore_config: String,
    state: String,
    name: String,
    is_available: bool,
}

fn get_mount_record(conn: &Connection, mount_id: &str) -> rusqlite::Result<MountRecord> {
    conn.query_row(
        "
        SELECT mounts.absolute_path, mounts.ignore_config, n.state, n.name, mounts.is_available
        FROM mounts
        INNER JOIN nodes n ON n.id = mounts.node_id
        WHERE mounts.node_id = ?1
        ",
        [mount_id],
        |row| {
            Ok(MountRecord {
                absolute_path: row.get(0)?,
                ignore_config: row.get(1)?,
                state: row.get(2)?,
                name: row.get(3)?,
                is_available: row.get::<_, i64>(4)? != 0,
            })
        },
    )
}

fn load_mount_entries(
    conn: &Connection,
    mount_id: &str,
) -> rusqlite::Result<Vec<PersistedMountEntry>> {
    let mut stmt = conn.prepare(
        "
        SELECT child.id,
               child.relative_path,
               parent.relative_path,
               child.name,
               child.kind,
               CAST(strftime('%s', child.created_at) AS INTEGER),
               CAST(strftime('%s', child.updated_at) AS INTEGER),
               child.size_bytes
        FROM nodes child
        LEFT JOIN nodes parent ON parent.id = child.parent_id
        WHERE child.mount_id = ?1
        ORDER BY child.relative_path
        ",
    )?;
    let rows = stmt.query_map([mount_id], |row| {
        Ok(PersistedMountEntry {
            id: row.get(0)?,
            relative_path: row.get(1)?,
            parent_relative_path: row.get(2)?,
            name: row.get(3)?,
            kind: NodeKind::from_db(&row.get::<_, String>(4)?),
            created_at_epoch: row.get(5)?,
            modified_at_epoch: row.get(6)?,
            size_bytes: row.get(7)?,
        })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PersistedMountEntry {
    id: String,
    relative_path: String,
    parent_relative_path: Option<String>,
    name: String,
    kind: NodeKind,
    created_at_epoch: Option<i64>,
    modified_at_epoch: Option<i64>,
    size_bytes: i64,
}

impl PersistedMountEntry {
    fn as_scanned_entry(&self) -> ScannedMountEntry {
        ScannedMountEntry {
            relative_path: self.relative_path.clone(),
            parent_relative_path: self.parent_relative_path.clone(),
            name: self.name.clone(),
            kind: self.kind,
            created_at_epoch: self.created_at_epoch,
            modified_at_epoch: self.modified_at_epoch,
            size_bytes: self.size_bytes,
        }
    }
}

fn validate_parent(conn: &Connection, parent_id: Option<&str>) -> rusqlite::Result<()> {
    if let Some(parent_id) = parent_id {
        let mut stmt = conn.prepare("SELECT 1 FROM nodes WHERE id = ?1 LIMIT 1")?;
        let parent_exists = stmt.exists([parent_id])?;
        if !parent_exists {
            return Err(rusqlite::Error::InvalidParameterName(
                "parent node does not exist".into(),
            ));
        }
    }

    Ok(())
}

fn normalize_ignore_config(ignore_config: Option<&str>) -> String {
    match ignore_config {
        Some(config) if !config.trim().is_empty() => config.to_string(),
        _ => DEFAULT_MOUNT_IGNORE_CONFIG.to_string(),
    }
}

fn insert_scanned_entries(
    conn: &Connection,
    mount_id: &str,
    scanned_entries: &[ScannedMountEntry],
    existing_ids_by_relative_path: &HashMap<String, String>,
) -> rusqlite::Result<Vec<String>> {
    let mut ids_by_relative_path: HashMap<String, String> = HashMap::new();
    let mut new_ids: Vec<String> = Vec::new();

    for entry in scanned_entries {
        let existing_id = existing_ids_by_relative_path
            .get(&entry.relative_path)
            .cloned();
        let is_new = existing_id.is_none();
        let node_id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let parent_id = entry
            .parent_relative_path
            .as_ref()
            .and_then(|path| ids_by_relative_path.get(path))
            .cloned()
            .unwrap_or_else(|| mount_id.to_string());

        conn.execute(
            "
            INSERT INTO nodes (
                id,
                parent_id,
                kind,
                name,
                state,
                mount_id,
                relative_path,
                created_at,
                updated_at,
                size_bytes
            )
            VALUES (
                ?1,
                ?2,
                ?3,
                ?4,
                ?5,
                ?6,
                ?7,
                COALESCE(datetime(?8, 'unixepoch'), CURRENT_TIMESTAMP),
                COALESCE(datetime(?9, 'unixepoch'), CURRENT_TIMESTAMP),
                ?10
            )
            ",
            params![
                node_id,
                parent_id,
                entry.kind.as_str(),
                entry.name,
                NodeState::Ready.as_str(),
                mount_id,
                entry.relative_path,
                entry.created_at_epoch,
                entry.modified_at_epoch,
                entry.size_bytes,
            ],
        )?;

        if is_new {
            new_ids.push(node_id.clone());
        }
        ids_by_relative_path.insert(entry.relative_path.clone(), node_id);
    }

    Ok(new_ids)
}
