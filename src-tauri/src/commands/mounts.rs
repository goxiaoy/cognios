use tauri::State;

use crate::domain::vfs::node::ExplorerSnapshotDto;
use crate::infrastructure::db::connection::open_database;
use crate::infrastructure::db::mount_repository::CreateMountInput;
use crate::services::mounts::create_mount::create_mount_snapshot;
use crate::AppState;

#[tauri::command]
pub fn create_mount(
    state: State<'_, AppState>,
    input: CreateMountInput,
) -> Result<ExplorerSnapshotDto, String> {
    let mut conn =
        open_database(&state.db_path).map_err(|error: rusqlite::Error| error.to_string())?;
    let created_mount = create_mount_snapshot(&mut conn, &input)?;
    state.mount_watchers.start_mount(
        state.db_path.clone(),
        created_mount.mount_id,
        std::path::PathBuf::from(created_mount.absolute_path),
    )?;

    Ok(created_mount.snapshot)
}
