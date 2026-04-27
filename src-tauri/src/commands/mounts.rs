use serde::Serialize;
use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::mount_repository::{
    find_existing_mount_by_absolute_path, list_existing_mounts, CreateMountInput, ExistingMount,
};
use crate::services::mounts::create_mount::create_mount_snapshot;
use crate::services::mounts::obsidian::{detect_obsidian_vaults, ObsidianVault};
use crate::services::mounts::scanner::normalize_mount_path;
use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountSetupContextDto {
    pub suggested_folders: Vec<ObsidianVault>,
    pub existing_mounts: Vec<ExistingMount>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CreateMountErrorDto {
    DuplicateMount {
        mount_id: String,
        mount_name: String,
        absolute_path: String,
        message: String,
    },
    Message {
        message: String,
    },
}

#[tauri::command]
pub fn create_mount(
    state: State<'_, AppState>,
    input: CreateMountInput,
) -> Result<ExplorerSnapshotDto, CreateMountErrorDto> {
    let mut conn =
        state
            .db
            .connect()
            .map_err(|error: rusqlite::Error| CreateMountErrorDto::Message {
                message: error.to_string(),
            })?;
    let normalized_path = normalize_mount_path(&input.path)
        .map_err(|message| CreateMountErrorDto::Message { message })?;
    if let Some(existing_mount) =
        find_existing_mount_by_absolute_path(&conn, &normalized_path.to_string_lossy()).map_err(
            |error| CreateMountErrorDto::Message {
                message: error.to_string(),
            },
        )?
    {
        return Err(CreateMountErrorDto::DuplicateMount {
            mount_id: existing_mount.node_id,
            mount_name: existing_mount.name,
            absolute_path: existing_mount.absolute_path,
            message: "This folder is already mounted.".into(),
        });
    }
    let created_mount = create_mount_snapshot(&mut conn, &input)
        .map_err(|message| CreateMountErrorDto::Message { message })?;
    state
        .mount_watchers
        .start_mount(
            state.db.clone(),
            created_mount.mount_id,
            std::path::PathBuf::from(created_mount.absolute_path),
        )
        .map_err(|message| CreateMountErrorDto::Message { message })?;

    Ok(created_mount.snapshot)
}

#[tauri::command]
pub fn get_mount_setup_context(state: State<'_, AppState>) -> Result<MountSetupContextDto, String> {
    let conn = state
        .db
        .connect()
        .map_err(|error: rusqlite::Error| error.to_string())?;
    let existing_mounts = list_existing_mounts(&conn).map_err(|error| error.to_string())?;
    let existing_paths = existing_mounts
        .iter()
        .map(|mount| mount.absolute_path.clone())
        .collect::<std::collections::HashSet<_>>();
    let suggested_folders = detect_obsidian_vaults()
        .into_iter()
        .filter(|vault| !existing_paths.contains(&vault.path))
        .collect::<Vec<_>>();

    Ok(MountSetupContextDto {
        suggested_folders,
        existing_mounts,
    })
}
