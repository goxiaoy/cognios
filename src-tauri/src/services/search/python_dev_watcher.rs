//! Dev-only file watcher that restarts the sidecar on Python edits.
//!
//! ``npm run tauri:dev`` already hot-reloads the React side via Vite
//! and triggers a Tauri restart on Rust source changes (cargo
//! rebuild → process exit → respawn → new sidecar). Python source
//! changes hit neither path: the running sidecar keeps the old
//! ``.pyc`` resident, and the dev loop ignores Python edits
//! entirely. That makes iterating on extractor / dispatcher logic
//! frustrating — every change requires a manual ``restart_sidecar``
//! click in Settings or a full ``tauri:dev`` relaunch.
//!
//! This module spawns a background watcher that polls
//! ``<workspace>/sidecar/search_sidecar/**`` for ``.py`` mutations.
//! On any change it debounces 500 ms (so a save triggered by an
//! IDE that touches several files in quick succession only fires
//! one restart), pauses new index claims, waits for active OCR work
//! to finish, then calls :meth:`SearchSidecarSupervisor::restart`,
//! which is the same graceful restart path the Settings UI uses.
//!
//! Gated behind ``#[cfg(debug_assertions)]`` so release builds
//! omit the watcher entirely — production sidecars must never
//! self-restart on filesystem mutations.

use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, PollWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::services::search::client::SearchSidecarClient;
use crate::services::search::safe_lifecycle::safe_restart_when_idle;
use crate::services::search::supervisor::SearchSidecarSupervisor;

const POLL_INTERVAL: Duration = Duration::from_millis(750);
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

/// Resolve the absolute path of ``sidecar/search_sidecar`` relative
/// to ``CARGO_MANIFEST_DIR`` (which cargo bakes in at compile time
/// and points at ``src-tauri/`` in dev).
fn sidecar_python_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.join("sidecar").join("search_sidecar"))
        .unwrap_or_else(|| manifest.join("../sidecar/search_sidecar"))
}

/// True when the changed path is a Python source file we care about.
/// Excludes ``__pycache__`` (compiled bytecode that tracks .py edits
/// and would double-fire) and anything that's not ``.py``.
fn is_relevant_path(path: &Path) -> bool {
    if path.components().any(|c| c.as_os_str() == "__pycache__") {
        return false;
    }
    path.extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext == "py")
        .unwrap_or(false)
}

/// Spawn the watcher on its own thread. Returns immediately; the
/// thread runs for the lifetime of the process.
///
/// On macOS the ``notify`` crate's event coalescing is reliable
/// only with the polling backend (the FSEvents backend drops events
/// during fast IDE saves that touch a temp file then rename it onto
/// the real path). Use ``PollWatcher`` to match the pattern the
/// mount watchers already use.
pub fn spawn_python_dev_watcher(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    app_handle: AppHandle,
) {
    let root = sidecar_python_root();
    if !root.is_dir() {
        log::info!(
            "python-dev-watcher: {} is not a directory; not spawning watcher",
            root.display()
        );
        return;
    }
    log::info!("python-dev-watcher: watching {}", root.display());

    std::thread::spawn(move || {
        let (tx, rx) = channel::<bool>();
        let restart_pending = Arc::new(AtomicBool::new(false));

        let tx_outer = tx.clone();
        let watcher_result = PollWatcher::new(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) => {
                    let relevant = event.paths.iter().any(|p| is_relevant_path(p));
                    if relevant {
                        let _ = tx_outer.send(true);
                    }
                }
                Err(err) => {
                    log::debug!("python-dev-watcher: notify error: {err}");
                }
            },
            Config::default()
                .with_poll_interval(POLL_INTERVAL)
                .with_compare_contents(true),
        );

        let mut watcher = match watcher_result {
            Ok(w) => w,
            Err(err) => {
                log::warn!("python-dev-watcher: watcher init failed: {err}");
                return;
            }
        };
        if let Err(err) = watcher.watch(&root, RecursiveMode::Recursive) {
            log::warn!(
                "python-dev-watcher: watch({}) failed: {err}",
                root.display()
            );
            return;
        }

        // Debounce loop: when an event arrives, wait for a quiet
        // window before firing the restart. If more events arrive
        // during the wait, the timer extends — IDEs that rewrite
        // multiple files on save (autoformatter + lint fix +
        // organize imports) all coalesce into one restart.
        loop {
            let _first = match rx.recv() {
                Ok(v) => v,
                Err(_) => return, // channel closed → app exiting
            };
            loop {
                match rx.recv_timeout(DEBOUNCE_WINDOW) {
                    Ok(_) => continue, // another change; reset the window
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if restart_pending.swap(true, Ordering::SeqCst) {
                log::info!("python-dev-watcher: restart already pending; coalescing change");
                continue;
            }
            log::info!("python-dev-watcher: Python source changed; scheduling safe restart");
            let supervisor = Arc::clone(&supervisor);
            let client = Arc::clone(&client);
            let app_handle = app_handle.clone();
            let restart_pending = Arc::clone(&restart_pending);
            tauri::async_runtime::spawn(async move {
                safe_restart_when_idle(supervisor, client, app_handle, "python-dev-watcher").await;
                restart_pending.store(false, Ordering::SeqCst);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn relevant_path_accepts_python_files() {
        assert!(is_relevant_path(&PathBuf::from("/x/foo.py")));
        assert!(is_relevant_path(&PathBuf::from("/x/y/bar.py")));
    }

    #[test]
    fn relevant_path_rejects_pycache_dir() {
        assert!(!is_relevant_path(&PathBuf::from(
            "/x/__pycache__/foo.cpython-313.pyc"
        )));
        assert!(!is_relevant_path(&PathBuf::from("/x/__pycache__/foo.py")));
    }

    #[test]
    fn relevant_path_rejects_non_python() {
        assert!(!is_relevant_path(&PathBuf::from("/x/README.md")));
        assert!(!is_relevant_path(&PathBuf::from("/x/queue.db")));
        assert!(!is_relevant_path(&PathBuf::from("/x/")));
    }
}
