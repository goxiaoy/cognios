use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::mount_repository::{list_mount_watch_configs, reconcile_mount};

const WATCHER_POLL_INTERVAL: Duration = Duration::from_millis(500);
const WATCHER_DEBOUNCE_WINDOW: Duration = Duration::from_millis(350);
const WATCHER_HEALTH_SYNC_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VfsChangeEvent {
    pub mount_id: String,
    pub reason: String,
    /// Populated only for cascading deletes (a Mount or Folder with
    /// children): the ids of every descendant node that was removed
    /// alongside ``mount_id``. The forwarder uses this to clean up
    /// lancedb chunks for every cascaded id, not just the parent.
    /// Empty for non-cascade events.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub descendant_ids: Vec<String>,
}

pub struct MountWatcherRegistry {
    emitter: Arc<dyn Fn(VfsChangeEvent) + Send + Sync>,
    workers: Mutex<HashMap<String, Sender<()>>>,
}

impl MountWatcherRegistry {
    pub fn new<F>(emitter: F) -> Self
    where
        F: Fn(VfsChangeEvent) + Send + Sync + 'static,
    {
        Self {
            emitter: Arc::new(emitter),
            workers: Mutex::new(HashMap::new()),
        }
    }

    pub fn start_all(&self, db: Database) -> Result<(), String> {
        let conn = db.connect().map_err(|error| error.to_string())?;
        let mounts = list_mount_watch_configs(&conn).map_err(|error| error.to_string())?;

        for mount in mounts {
            self.start_mount(
                db.clone(),
                mount.mount_id,
                PathBuf::from(mount.absolute_path),
            )?;
        }

        Ok(())
    }

    pub fn start_mount(
        &self,
        db: Database,
        mount_id: String,
        mount_path: PathBuf,
    ) -> Result<(), String> {
        let mut workers = self.workers.lock().map_err(|_| "watcher lock poisoned")?;
        if workers.contains_key(&mount_id) {
            return Ok(());
        }

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let emitter = Arc::clone(&self.emitter);
        let mount_id_for_thread = mount_id.clone();

        std::thread::spawn(move || {
            let (event_tx, event_rx) = mpsc::channel::<()>();
            let mut watcher = create_watcher(&mount_path, event_tx.clone()).ok();
            let mut path_exists = mount_path.is_dir();
            let mut last_health_sync = Instant::now();

            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                if path_exists && !mount_path.is_dir() {
                    path_exists = false;
                    watcher = None;
                    reconcile_and_emit(&db, &mount_id_for_thread, "mount-unavailable", &emitter);
                    last_health_sync = Instant::now();
                    continue;
                }

                if !path_exists && mount_path.is_dir() {
                    path_exists = true;
                    watcher = create_watcher(&mount_path, event_tx.clone()).ok();
                    reconcile_and_emit(&db, &mount_id_for_thread, "mount-available", &emitter);
                    last_health_sync = Instant::now();
                    continue;
                }

                match event_rx.recv_timeout(WATCHER_POLL_INTERVAL) {
                    Ok(()) => {
                        while event_rx.recv_timeout(WATCHER_DEBOUNCE_WINDOW).is_ok() {}
                        reconcile_and_emit(&db, &mount_id_for_thread, "mount-sync", &emitter);
                        last_health_sync = Instant::now();
                        if watcher.is_none() && mount_path.is_dir() {
                            watcher = create_watcher(&mount_path, event_tx.clone()).ok();
                            path_exists = watcher.is_some();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if path_exists && last_health_sync.elapsed() >= WATCHER_HEALTH_SYNC_INTERVAL
                        {
                            reconcile_and_emit(
                                &db,
                                &mount_id_for_thread,
                                "mount-health-sync",
                                &emitter,
                            );
                            last_health_sync = Instant::now();
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        workers.insert(mount_id, stop_tx);

        Ok(())
    }

    pub fn stop_all(&self) {
        if let Ok(mut workers) = self.workers.lock() {
            for (_, stop_tx) in workers.drain() {
                let _ = stop_tx.send(());
            }
        }
    }

    pub fn stop_mount(&self, mount_id: &str) {
        if let Ok(mut workers) = self.workers.lock() {
            if let Some(stop_tx) = workers.remove(mount_id) {
                let _ = stop_tx.send(());
            }
        }
    }
}

impl Drop for MountWatcherRegistry {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn create_watcher(path: &Path, event_tx: Sender<()>) -> notify::Result<PollWatcher> {
    let mut watcher = PollWatcher::new(
        move |result: notify::Result<notify::Event>| {
            let _ = match result {
                Ok(_) => event_tx.send(()),
                Err(_) => event_tx.send(()),
            };
        },
        Config::default()
            .with_poll_interval(WATCHER_POLL_INTERVAL)
            .with_compare_contents(true),
    )?;
    watcher.watch(path, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn reconcile_and_emit(
    db: &Database,
    mount_id: &str,
    reason: &str,
    emitter: &Arc<dyn Fn(VfsChangeEvent) + Send + Sync>,
) {
    let mut conn = match db.connect() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("failed to open database for watcher reconcile: {error}");
            return;
        }
    };

    let outcome = match reconcile_mount(&mut conn, mount_id) {
        Ok(outcome) => outcome,
        Err(error) => {
            eprintln!("failed to reconcile mount {mount_id}: {error}");
            return;
        }
    };

    if !outcome.changed {
        return;
    }

    emitter(VfsChangeEvent {
        mount_id: mount_id.to_string(),
        reason: reason.to_string(),
        ..Default::default()
    });
}
