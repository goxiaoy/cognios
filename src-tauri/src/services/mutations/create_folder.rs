use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::vfs::node::NodeKind;
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::mount_repository::reconcile_mount;
use crate::infrastructure::db::node_repository::{
    create_folder as create_app_folder, list_snapshot, CreateFolderInput, CreatedFolder,
};
use crate::infrastructure::fs::path_mapper::to_relative_path_string;
use crate::services::mounts::scanner::is_ignored_path;
use crate::services::mounts::watcher::VfsChangeEvent;

pub fn create_folder(
    conn: &mut Connection,
    input: &CreateFolderInput,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedFolder, String> {
    let name = validate_folder_name(&input.name)?;
    let Some(parent_id) = input.parent_id.as_deref() else {
        return create_app_folder_and_emit(conn, input, emitter);
    };

    let parent =
        load_parent(conn, parent_id)?.ok_or_else(|| "parent node not found".to_string())?;
    match parent.backing {
        ParentBacking::AppFolder => create_app_folder_and_emit(conn, input, emitter),
        ParentBacking::MountRoot { mount_id } => {
            create_mounted_folder(conn, parent_id, &mount_id, None, name, emitter)
        }
        ParentBacking::MountedFolder {
            mount_id,
            relative_path,
        } => create_mounted_folder(
            conn,
            parent_id,
            &mount_id,
            Some(&relative_path),
            name,
            emitter,
        ),
        ParentBacking::UnavailableMount => Err("mounted path is unavailable".into()),
        ParentBacking::NonContainer => Err("parent is not a folder".into()),
    }
}

fn create_app_folder_and_emit(
    conn: &Connection,
    input: &CreateFolderInput,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedFolder, String> {
    let created = create_app_folder(conn, input).map_err(|error| error.to_string())?;
    emitter(VfsChangeEvent {
        mount_id: created.node_id.clone(),
        reason: "node-created".to_string(),
        ..Default::default()
    });
    Ok(created)
}

fn create_mounted_folder(
    conn: &mut Connection,
    parent_id: &str,
    mount_id: &str,
    parent_relative_path: Option<&str>,
    name: &str,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<CreatedFolder, String> {
    let mount = load_mount_info(conn, mount_id)?
        .ok_or_else(|| "mounted folder missing mount".to_string())?;
    if mount.state == NodeState::Unavailable.as_str() {
        return Err("mounted path is unavailable".into());
    }

    let target_relative_path = match parent_relative_path {
        Some(parent) if !parent.is_empty() => {
            to_relative_path_string(&PathBuf::from(parent).join(name))
        }
        _ => name.to_string(),
    };
    let mount_root = PathBuf::from(&mount.absolute_path);
    let target_path = mount_root.join(&target_relative_path);
    if !target_path.starts_with(&mount_root) {
        return Err("folder path escapes mount root".into());
    }
    if target_path.exists() {
        return Err("folder already exists".into());
    }
    if is_ignored_path(&mount_root, &mount.ignore_config, &target_path, true)? {
        return Err("folder is excluded by this mount's ignore rules".into());
    }

    fs::create_dir(&target_path).map_err(|error| error.to_string())?;
    reconcile_mount(conn, mount_id).map_err(|error| error.to_string())?;

    let node_id = conn
        .query_row(
            "SELECT id FROM nodes WHERE mount_id = ?1 AND relative_path = ?2",
            params![mount_id, target_relative_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "created folder was not visible after mount reconciliation".to_string())?;

    touch_parent_if_needed(conn, parent_id).map_err(|error| error.to_string())?;
    emitter(VfsChangeEvent {
        mount_id: node_id.clone(),
        reason: "node-created".to_string(),
        ..Default::default()
    });
    let snapshot = list_snapshot(conn).map_err(|error| error.to_string())?;
    Ok(CreatedFolder { node_id, snapshot })
}

fn validate_folder_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("folder name must not be empty".into());
    }
    let path = Path::new(trimmed);
    let mut components = path.components();
    let first = components.next();
    if components.next().is_some()
        || !matches!(first, Some(Component::Normal(_)))
        || trimmed.contains(std::path::MAIN_SEPARATOR)
        || trimmed.contains('/')
    {
        return Err("folder name must not contain path separators".into());
    }
    Ok(trimmed)
}

fn touch_parent_if_needed(conn: &Connection, parent_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [parent_id],
    )?;
    Ok(())
}

#[derive(Debug)]
struct ParentNode {
    backing: ParentBacking,
}

#[derive(Debug)]
enum ParentBacking {
    AppFolder,
    MountRoot {
        mount_id: String,
    },
    MountedFolder {
        mount_id: String,
        relative_path: String,
    },
    UnavailableMount,
    NonContainer,
}

fn load_parent(conn: &Connection, node_id: &str) -> Result<Option<ParentNode>, String> {
    conn.query_row(
        "
        SELECT n.kind, n.mount_id, n.relative_path, n.state, m.state
        FROM nodes n
        LEFT JOIN nodes m ON m.id = n.mount_id
        WHERE n.id = ?1
        ",
        [node_id],
        |row| {
            let kind = NodeKind::from_db(&row.get::<_, String>(0)?);
            let mount_id: Option<String> = row.get(1)?;
            let relative_path: Option<String> = row.get(2)?;
            let state: String = row.get(3)?;
            let mount_state: Option<String> = row.get(4)?;
            let backing = match kind {
                NodeKind::Mount => {
                    if state == NodeState::Unavailable.as_str() {
                        ParentBacking::UnavailableMount
                    } else {
                        ParentBacking::MountRoot {
                            mount_id: node_id.to_string(),
                        }
                    }
                }
                NodeKind::Folder => match (mount_id, relative_path, mount_state) {
                    (Some(_), Some(_), Some(mount_state))
                        if mount_state == NodeState::Unavailable.as_str() =>
                    {
                        ParentBacking::UnavailableMount
                    }
                    (Some(mount_id), Some(relative_path), _) => ParentBacking::MountedFolder {
                        mount_id,
                        relative_path,
                    },
                    _ => ParentBacking::AppFolder,
                },
                _ => ParentBacking::NonContainer,
            };
            Ok(ParentNode { backing })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[derive(Debug)]
struct MountInfo {
    absolute_path: String,
    ignore_config: String,
    state: String,
}

fn load_mount_info(conn: &Connection, mount_id: &str) -> Result<Option<MountInfo>, String> {
    conn.query_row(
        "
        SELECT mounts.absolute_path, mounts.ignore_config, nodes.state
        FROM mounts
        INNER JOIN nodes ON nodes.id = mounts.node_id
        WHERE mounts.node_id = ?1
        ",
        [mount_id],
        |row| {
            Ok(MountInfo {
                absolute_path: row.get(0)?,
                ignore_config: row.get(1)?,
                state: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}
