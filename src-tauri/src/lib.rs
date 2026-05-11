pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod services;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::infrastructure::db::connection::Database;
use crate::services::mounts::reconcile::reconcile_all_mounts;
use crate::services::mounts::watcher::{MountWatcherRegistry, VfsChangeEvent};
use crate::services::search::{SearchSidecarClient, SearchSidecarSupervisor};
use crate::services::url_indexing::cache::ensure_cache_dir;
use crate::services::url_indexing::queue::UrlJobRunner;

const VFS_EVENT_NAME: &str = "vfs://changed";

pub type VfsEventEmitter = Arc<dyn Fn(VfsChangeEvent) + Send + Sync>;

pub struct AppState {
    pub db: Database,
    pub storage_dir: PathBuf,
    pub mount_watchers: Arc<MountWatcherRegistry>,
    pub url_jobs: Arc<UrlJobRunner>,
    pub emitter: VfsEventEmitter,
    pub search_sidecar: Arc<SearchSidecarSupervisor>,
    pub search_client: Arc<SearchSidecarClient>,
    pub shutdown_requested: Arc<AtomicBool>,
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
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app_handle = window.app_handle();
                let state = app_handle.state::<AppState>();
                if state.shutdown_requested.swap(true, Ordering::SeqCst) {
                    return;
                }
                let search_sidecar = Arc::clone(&state.search_sidecar);
                let search_client = Arc::clone(&state.search_client);
                let mount_watchers = Arc::clone(&state.mount_watchers);
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    services::search::safe_lifecycle::safe_stop_when_idle(
                        search_sidecar,
                        search_client,
                        "app-close",
                    )
                    .await;
                    mount_watchers.stop_all();
                    app_handle.exit(0);
                });
            }
        })
        .setup(|app| {
            let home_dir = app
                .path()
                .home_dir()
                .map_err(|error: tauri::Error| error.to_string())?;
            let app_data_dir = storage_dir_from_home(home_dir);

            fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
            fs::create_dir_all(app_data_dir.join("notes")).map_err(|error| error.to_string())?;

            let db_path = app_data_dir.join("cognios.db");
            let db = Database::new(db_path);
            let cache_dir = app_data_dir.join("url-cache");
            let mut conn = db
                .connect()
                .map_err(|error: rusqlite::Error| error.to_string())?;
            let recovered_memories =
                services::chat::session_memory::recover_orphaned_refreshes(&conn)
                    .map_err(|error| error.to_string())?;
            if recovered_memories > 0 {
                log::info!(
                    "recovered {recovered_memories} interrupted session memory refresh job(s)"
                );
            }
            let pending_memory_refreshes =
                services::chat::session_memory::pending_refresh_session_ids(&conn)
                    .map_err(|error| error.to_string())?;
            reconcile_all_mounts(&mut conn)?;
            ensure_cache_dir(&cache_dir)?;

            // Search sidecar (Phase 1 / Unit 2). Construct before the
            // emitter so the wrapped emitter can capture the client and
            // forward node mutations to the sidecar's `/events/node`.
            let search_dir = app_data_dir.join("search");
            fs::create_dir_all(&search_dir).map_err(|error| error.to_string())?;
            let search_sidecar = Arc::new(SearchSidecarSupervisor::new(
                search_dir.join("sidecar.runtime"),
                app_data_dir.clone(),
            ));
            search_sidecar.start(app.handle());
            let search_client = Arc::new(SearchSidecarClient::new(Arc::clone(&search_sidecar)));

            if !pending_memory_refreshes.is_empty() {
                let memory_app_handle = app.handle().clone();
                let memory_db = db.clone();
                let memory_storage_dir = app_data_dir.clone();
                let memory_client = Arc::clone(&search_client);
                let memory_supervisor = Arc::clone(&search_sidecar);
                tauri::async_runtime::spawn(async move {
                    use crate::services::search::SupervisorState;
                    use std::time::Duration;

                    let step = Duration::from_millis(500);
                    loop {
                        match memory_supervisor.state() {
                            SupervisorState::Running { .. } => break,
                            SupervisorState::Failed {
                                retryable: false, ..
                            }
                            | SupervisorState::Stopped => {
                                log::warn!(
                                    "session memory startup refresh skipped: sidecar unavailable"
                                );
                                return;
                            }
                            _ => tokio::time::sleep(step).await,
                        }
                    }

                    log::info!(
                        "scheduling {} pending session memory refresh job(s) after startup",
                        pending_memory_refreshes.len()
                    );
                    for session_id in pending_memory_refreshes {
                        commands::chat::spawn_memory_refresh(
                            memory_app_handle.clone(),
                            memory_db.clone(),
                            memory_storage_dir.clone(),
                            Arc::clone(&memory_client),
                            session_id,
                        );
                    }
                });
            }

            // Single emitter shared by every emit site (mount watchers,
            // URL jobs, and the note/folder mutation paths). It does
            // two things: (1) emits the existing Tauri webview event
            // for the React explorer to refresh; (2) translates
            // node-* and url-indexed reasons into a `/events/node`
            // payload and fire-and-forget posts it to the search
            // sidecar so the indexer picks the change up.
            let emit_app_handle = app.handle().clone();
            let forwarder_client = Arc::clone(&search_client);
            let forwarder_db = db.clone();
            let forwarder_storage_dir = app_data_dir.clone();
            let emitter: VfsEventEmitter = Arc::new(move |event: VfsChangeEvent| {
                let _ = emit_app_handle.emit(VFS_EVENT_NAME, event.clone());

                let client = Arc::clone(&forwarder_client);
                let db = forwarder_db.clone();
                let storage_dir = forwarder_storage_dir.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(payload) =
                        services::search::forwarder::build_payload(&event, &db, &storage_dir)
                    {
                        client.forward_node_event(&payload).await;
                    }
                    // Cascading deletes (Mount or Folder with children)
                    // also need every descendant id cleaned up in
                    // lancedb. The forwarder above sends the parent's
                    // single payload; this fans out the rest.
                    if event.reason == "node-deleted" && !event.descendant_ids.is_empty() {
                        services::search::forwarder::forward_descendant_deletes(
                            &client,
                            &event.descendant_ids,
                        )
                        .await;
                    }
                });
            });

            let mount_watchers = {
                let emitter = Arc::clone(&emitter);
                Arc::new(MountWatcherRegistry::new(move |event: VfsChangeEvent| {
                    emitter(event);
                }))
            };
            mount_watchers.start_all(db.clone())?;

            let url_jobs = {
                let emitter = Arc::clone(&emitter);
                Arc::new(UrlJobRunner::new(
                    db.clone(),
                    cache_dir,
                    move |event: VfsChangeEvent| {
                        emitter(event);
                    },
                ))
            };
            url_jobs.resume_pending_jobs()?;

            // Startup resync: once the sidecar reaches Running, diff
            // its index against cognios.db and forward only the stale
            // entries. For an unchanged workspace this is one HTTP
            // call (the snapshot fetch) plus an in-memory diff;
            // first-launch / post-crash workspaces forward exactly the
            // nodes that need indexing. Backgrounded so it never
            // blocks setup().
            {
                let resync_db = db.clone();
                let resync_client = Arc::clone(&search_client);
                let resync_storage = app_data_dir.clone();
                let resync_supervisor = Arc::clone(&search_sidecar);
                tauri::async_runtime::spawn(async move {
                    use crate::services::search::SupervisorState;
                    use std::time::Duration;
                    // Wait for the sidecar to be Running. Local OCR
                    // model initialisation can exceed a fixed timeout
                    // in dev, and skipping this task leaves existing
                    // nodes un-forwarded until another mutation happens.
                    let step = Duration::from_millis(500);
                    loop {
                        match resync_supervisor.state() {
                            SupervisorState::Running { .. } => break,
                            SupervisorState::Failed {
                                retryable: false, ..
                            } => {
                                log::info!(
                                    "startup resync skipped: sidecar failed terminally before Running"
                                );
                                return;
                            }
                            _ => {
                                tokio::time::sleep(step).await;
                            }
                        }
                    }
                    let summary = services::search::forwarder::resync_all_nodes(
                        &resync_db,
                        &resync_client,
                        &resync_storage,
                    )
                    .await;
                    log::info!(
                        "startup resync complete: forwarded={} deleted={} skipped={}",
                        summary.forwarded,
                        summary.deleted,
                        summary.skipped
                    );
                });
            }

            // Live state mirror: poll ``GET /index/changes`` and write
            // sidecar transitions back into ``nodes.state`` so the
            // explorer's index-state dot follows the actual queue
            // state. Cost is proportional to the change rate, not
            // the corpus size — see services::search::index_state_sync.
            {
                let sync_db = db.clone();
                let sync_client = Arc::clone(&search_client);
                let sync_supervisor = Arc::clone(&search_sidecar);
                let sync_app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    services::search::index_state_sync::run_index_state_sync(
                        sync_supervisor,
                        sync_client,
                        sync_db,
                        sync_app_handle,
                    )
                    .await;
                });
            }

            // Advanced-OCR watcher: when the 13-stage PP-StructureV3
            // bundle finishes downloading, ask the sidecar to backfill
            // indexed documents for background enhancement. Cloud
            // advanced-OCR doesn't trigger this — keys are usable
            // immediately and bulk cloud backfill is intentionally
            // manual.
            {
                let watch_client = Arc::clone(&search_client);
                let watch_supervisor = Arc::clone(&search_sidecar);
                tauri::async_runtime::spawn(async move {
                    services::search::advanced_ocr_watcher::run_advanced_ocr_watcher(
                        watch_supervisor,
                        watch_client,
                    )
                    .await;
                });
            }

            // Dev-only Python source watcher: in ``npm run tauri:dev``,
            // ``.py`` edits don't currently trigger anything (Vite
            // handles the frontend, cargo handles Rust, the sidecar's
            // a separate process). Adds a debounced watcher that
            // calls supervisor.restart() on any Python source change
            // under ``sidecar/search_sidecar``. Compiled out of
            // release builds via ``#[cfg(debug_assertions)]``.
            #[cfg(debug_assertions)]
            {
                services::search::python_dev_watcher::spawn_python_dev_watcher(
                    Arc::clone(&search_sidecar),
                    Arc::clone(&search_client),
                    app.handle().clone(),
                );
            }

            app.manage(AppState {
                db,
                storage_dir: app_data_dir,
                mount_watchers,
                url_jobs,
                emitter,
                search_sidecar,
                search_client,
                shutdown_requested: Arc::new(AtomicBool::new(false)),
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
            commands::nodes::reindex_node,
            commands::notes::create_note,
            commands::notes::get_note_content,
            commands::notes::save_note_content,
            commands::voice_notes::get_voice_note_capture_capability,
            commands::voice_notes::create_voice_note,
            commands::voice_notes::list_voice_notes,
            commands::voice_notes::get_voice_note,
            commands::voice_notes::complete_voice_note_transcript,
            commands::voice_notes::begin_voice_note_audio_capture,
            commands::voice_notes::append_voice_note_audio_chunk,
            commands::voice_notes::finish_voice_note_audio_capture,
            commands::voice_notes::rename_voice_note_speaker,
            commands::voice_notes::delete_voice_note_source_audio,
            commands::files::read_file_content,
            commands::files::show_node_in_file_manager,
            commands::files::show_node_extract_artifacts,
            commands::thumbnails::get_node_thumbnail,
            commands::urls::create_url,
            commands::urls::retry_url,
            commands::chat::create_chat_session,
            commands::chat::list_chat_sessions,
            commands::chat::get_chat_session,
            commands::chat::get_chat_session_memory,
            commands::chat::export_chat_session_memory,
            commands::chat::delete_chat_session,
            commands::chat::update_chat_session_title,
            commands::chat::append_chat_message,
            commands::chat::record_chat_cluster,
            commands::chat::bind_chat_note,
            commands::chat::start_chat_turn,
            commands::chat::trigger_chat_session_memory_opportunity,
            commands::chat::get_chat_models,
            commands::chat::test_chat_provider,
            commands::search::search_query,
            commands::search::get_indexing_status,
            commands::search::get_search_observability,
            commands::search::get_node_indexing_status,
            commands::search::get_node_content,
            commands::search::get_models_status,
            commands::search::start_model_download,
            commands::secrets::set_provider_secret,
            commands::secrets::get_provider_secret_present,
            commands::secrets::delete_provider_secret,
            commands::search_settings::get_search_settings,
            commands::search_settings::update_search_settings,
            commands::search_settings::read_search_settings_fallback,
            commands::search_settings::restart_sidecar
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
