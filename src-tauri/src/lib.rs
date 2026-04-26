pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod services;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::infrastructure::db::connection::open_database;
use crate::services::mounts::reconcile::reconcile_all_mounts;
use crate::services::mounts::watcher::{MountWatcherRegistry, VfsChangeEvent};
use crate::services::search::SearchSidecarSupervisor;
use crate::services::url_indexing::cache::ensure_cache_dir;
use crate::services::url_indexing::queue::UrlJobRunner;

const VFS_EVENT_NAME: &str = "vfs://changed";

pub type VfsEventEmitter = Arc<dyn Fn(VfsChangeEvent) + Send + Sync>;

pub struct AppState {
    pub db_path: PathBuf,
    pub storage_dir: PathBuf,
    pub mount_watchers: Arc<MountWatcherRegistry>,
    pub url_jobs: Arc<UrlJobRunner>,
    pub emitter: VfsEventEmitter,
    pub search_sidecar: Arc<SearchSidecarSupervisor>,
}

fn storage_dir_from_home(home_dir: PathBuf) -> PathBuf {
    home_dir.join(".cogios")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .level_for("cognios_lib", log::LevelFilter::Debug)
                .build(),
        )
        .setup(|app| {
            let home_dir = app
                .path()
                .home_dir()
                .map_err(|error: tauri::Error| error.to_string())?;
            let app_data_dir = storage_dir_from_home(home_dir);

            fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
            fs::create_dir_all(app_data_dir.join("notes"))
                .map_err(|error| error.to_string())?;

            let db_path = app_data_dir.join("cognios.db");
            let cache_dir = app_data_dir.join("url-cache");
            let mut conn =
                open_database(&db_path).map_err(|error: rusqlite::Error| error.to_string())?;
            reconcile_all_mounts(&mut conn)?;
            ensure_cache_dir(&cache_dir)?;

            // Single emitter shared by every emit site (mount watchers,
            // URL jobs, and the new mutation paths added for search). All
            // callers route through `app_handle.emit(VFS_EVENT_NAME, ...)`.
            let emit_app_handle = app.handle().clone();
            let emitter: VfsEventEmitter = Arc::new(move |event: VfsChangeEvent| {
                let _ = emit_app_handle.emit(VFS_EVENT_NAME, event);
            });

            let mount_watchers = {
                let emitter = Arc::clone(&emitter);
                Arc::new(MountWatcherRegistry::new(move |event: VfsChangeEvent| {
                    emitter(event);
                }))
            };
            mount_watchers.start_all(&db_path)?;

            let url_jobs = {
                let emitter = Arc::clone(&emitter);
                Arc::new(UrlJobRunner::new(
                    db_path.clone(),
                    cache_dir,
                    move |event: VfsChangeEvent| {
                        emitter(event);
                    },
                ))
            };
            url_jobs.resume_pending_jobs()?;

            // Search sidecar (Phase 1 / Unit 2). The binary is bundled
            // by the packaging step in Unit 12; in dev or before that
            // ships, the supervisor records `Failed { retryable: false }`
            // and the rest of the app continues to run.
            let search_dir = app_data_dir.join("search");
            fs::create_dir_all(&search_dir).map_err(|error| error.to_string())?;
            let search_sidecar = Arc::new(SearchSidecarSupervisor::new(
                search_dir.join("sidecar.runtime"),
                app_data_dir.clone(),
            ));
            search_sidecar.start(app.handle());

            app.manage(AppState {
                db_path,
                storage_dir: app_data_dir,
                mount_watchers,
                url_jobs,
                emitter,
                search_sidecar,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_explorer_snapshot,
            commands::create_folder,
            commands::mounts::create_mount,
            commands::mounts::get_mount_setup_context,
            commands::nodes::rename_node,
            commands::nodes::delete_node,
            commands::notes::create_note,
            commands::notes::get_note_content,
            commands::notes::save_note_content,
            commands::files::read_file_content,
            commands::files::show_node_in_file_manager,
            commands::thumbnails::get_node_thumbnail,
            commands::urls::create_url,
            commands::urls::retry_url
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::storage_dir_from_home;

    #[test]
    fn stores_data_in_hidden_home_directory() {
        let home_dir = PathBuf::from("/tmp/example-home");

        let storage_dir = storage_dir_from_home(home_dir);

        assert_eq!(storage_dir, PathBuf::from("/tmp/example-home/.cogios"));
    }
}
