//! Supervises the Python `search-sidecar` child process.
//!
//! Lifecycle (Phase 1 / Unit 2 — single-attempt; restart-on-crash with
//! exponential backoff is a follow-up commit on this branch):
//!
//! 1. `start()` spawns the search sidecar with `serve --storage-dir
//!    <abs-path>` arguments. Dev builds run the local Python package from
//!    `sidecar/`; packaged builds run `binaries/search-sidecar` via
//!    Tauri's sidecar API. Pumps the CommandEvent stream in a background
//!    tokio task; logs stdout/stderr at debug level; transitions state to
//!    `Failed` on `Terminated`.
//! 2. A second background task polls the runtime file (1 s ticks, 30 s
//!    deadline). On success, transitions state to `Running { runtime }`.
//! 3. `kill()` calls `child.kill()` on the stored handle (called from
//!    Tauri's window-close handler in `lib.rs`).
//!
//! If no candidate can be spawned, `start()` transitions to `Failed` and
//! logs the attempted launch paths — the rest of the app continues to work.
//! Search and captioning are simply unavailable.

#[cfg(debug_assertions)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_shell::process::{Command, CommandChild};
use tauri_plugin_shell::ShellExt;

use super::runtime_file::{read_runtime_file, RuntimeFile, RuntimeFileError};

const RUNTIME_POLL_INTERVAL: Duration = Duration::from_secs(1);
const RUNTIME_READY_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_BINARY_NAME: &str = "search-sidecar";

struct SidecarCommandCandidate {
    label: &'static str,
    command: Command,
}

/// Public state snapshot — what the rest of the app sees about the
/// supervisor at any moment.
#[derive(Debug, Clone)]
pub enum SupervisorState {
    NotStarted,
    Spawning,
    Running { runtime: RuntimeFile },
    Failed { reason: String, retryable: bool },
    Stopped,
}

impl SupervisorState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Stopped
                | Self::Failed {
                    retryable: false,
                    ..
                }
        )
    }
}

pub struct SearchSidecarSupervisor {
    inner: Arc<Mutex<Inner>>,
    runtime_path: PathBuf,
    storage_dir: PathBuf,
}

struct Inner {
    state: SupervisorState,
    child: Option<CommandChild>,
}

impl SearchSidecarSupervisor {
    /// `runtime_path` = `~/.cogios/search/sidecar.runtime`
    /// `storage_dir` = `~/.cogios` (the sidecar's `--storage-dir` arg)
    pub fn new(runtime_path: PathBuf, storage_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: SupervisorState::NotStarted,
                child: None,
            })),
            runtime_path,
            storage_dir,
        }
    }

    pub fn state(&self) -> SupervisorState {
        self.inner
            .lock()
            .map(|inner| inner.state.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().state.clone())
    }

    fn set_state(&self, state: SupervisorState) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.state = state;
        }
    }

    fn store_child(&self, child: CommandChild) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.child = Some(child);
        }
    }

    fn take_child(&self) -> Option<CommandChild> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.child.take())
    }

    /// Spawn the sidecar and return immediately. Background tasks pump
    /// process events and poll the runtime file. Errors that prevent
    /// spawn (binary missing, permission denied) are recorded as
    /// `Failed` state — they do not bubble out, because the rest of the
    /// app must keep running.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        self.set_state(SupervisorState::Spawning);

        let storage_dir_str = self.storage_dir.to_string_lossy().into_owned();
        let (mut rx, child) = match spawn_first_available_sidecar(app, &storage_dir_str) {
            Ok(spawned) => spawned,
            Err(reason) => {
                log::warn!("{reason}");
                self.set_state(SupervisorState::Failed {
                    reason,
                    retryable: true,
                });
                return;
            }
        };

        self.store_child(child);

        // Pump child stdout/stderr/terminated events.
        let supervisor = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        log::debug!("[sidecar stdout] {}", String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Stderr(bytes) => {
                        log::debug!("[sidecar stderr] {}", String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Terminated(payload) => {
                        let reason = format!(
                            "sidecar terminated: code={:?}, signal={:?}",
                            payload.code, payload.signal
                        );
                        log::warn!("{reason}");
                        supervisor.set_state(SupervisorState::Failed {
                            reason,
                            retryable: true,
                        });
                        break;
                    }
                    CommandEvent::Error(err) => {
                        log::warn!("sidecar error event: {err}");
                    }
                    _ => {}
                }
            }
        });

        // Poll the runtime file until it appears or we hit the deadline.
        let supervisor = Arc::clone(self);
        let runtime_path = self.runtime_path.clone();
        tauri::async_runtime::spawn(async move {
            let deadline = std::time::Instant::now() + RUNTIME_READY_TIMEOUT;
            let mut last_err: Option<RuntimeFileError> = None;
            while std::time::Instant::now() < deadline {
                match read_runtime_file(&runtime_path) {
                    Ok(runtime) => {
                        log::info!("search sidecar runtime ready on port {}", runtime.port);
                        supervisor.set_state(SupervisorState::Running { runtime });
                        return;
                    }
                    Err(RuntimeFileError::NotFound(_)) => {
                        // Not written yet — keep polling.
                    }
                    Err(err) => {
                        // Symlink, malformed JSON, invalid token/port —
                        // retain for the deadline-miss diagnostic.
                        last_err = Some(err);
                    }
                }
                tokio::time::sleep(RUNTIME_POLL_INTERVAL).await;
            }

            // Don't trample a Running state set by the success branch
            // (race: deadline elapsed milliseconds after success).
            if matches!(supervisor.state(), SupervisorState::Running { .. }) {
                return;
            }
            let reason = match last_err {
                Some(err) => format!("runtime file invalid after {RUNTIME_READY_TIMEOUT:?}: {err}"),
                None => format!("runtime file not produced within {RUNTIME_READY_TIMEOUT:?}"),
            };
            log::warn!("{reason}");
            supervisor.set_state(SupervisorState::Failed {
                reason,
                retryable: true,
            });
        });
    }

    /// Called from Tauri's window-close handler. Kills the child if it
    /// is still alive and transitions to `Stopped`.
    pub fn kill(&self) {
        if let Some(child) = self.take_child() {
            if let Err(err) = child.kill() {
                log::warn!("failed to kill sidecar child: {err}");
            }
        }
        self.set_state(SupervisorState::Stopped);
    }
}

fn spawn_first_available_sidecar(
    app: &AppHandle,
    storage_dir: &str,
) -> Result<
    (
        tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
        CommandChild,
    ),
    String,
> {
    let mut errors = Vec::new();

    for candidate in sidecar_command_candidates(app, storage_dir) {
        match candidate.command.spawn() {
            Ok((rx, child)) => {
                log::info!("started search sidecar via {}", candidate.label);
                return Ok((rx, child));
            }
            Err(err) => {
                errors.push(format!("{}: {err}", candidate.label));
            }
        }
    }

    Err(format!(
        "sidecar spawn failed; attempted {}",
        errors.join("; ")
    ))
}

fn sidecar_command_candidates(app: &AppHandle, storage_dir: &str) -> Vec<SidecarCommandCandidate> {
    let mut candidates = Vec::new();

    #[cfg(debug_assertions)]
    {
        let sidecar_dir = dev_sidecar_dir();
        candidates.push(SidecarCommandCandidate {
            label: "local Python sidecar via uv",
            command: app.shell().command("uv").current_dir(&sidecar_dir).args([
                "run",
                "search-sidecar",
                "serve",
                "--storage-dir",
                storage_dir,
            ]),
        });

        let venv_python = dev_venv_python_path(&sidecar_dir);
        if venv_python.exists() {
            candidates.push(SidecarCommandCandidate {
                label: "local Python sidecar via sidecar/.venv",
                command: app
                    .shell()
                    .command(venv_python)
                    .current_dir(&sidecar_dir)
                    .args([
                        "-m",
                        "search_sidecar",
                        "serve",
                        "--storage-dir",
                        storage_dir,
                    ]),
            });
        }
    }

    match app.shell().sidecar(SIDECAR_BINARY_NAME) {
        Ok(command) => candidates.push(SidecarCommandCandidate {
            label: "packaged Tauri sidecar",
            command: command.args(["serve", "--storage-dir", storage_dir]),
        }),
        Err(err) => log::info!("could not resolve packaged sidecar binary: {err}"),
    }

    candidates
}

#[cfg(debug_assertions)]
fn dev_sidecar_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .join("sidecar")
}

#[cfg(all(debug_assertions, windows))]
fn dev_venv_python_path(sidecar_dir: &Path) -> PathBuf {
    sidecar_dir.join(".venv").join("Scripts").join("python.exe")
}

#[cfg(all(debug_assertions, not(windows)))]
fn dev_venv_python_path(sidecar_dir: &Path) -> PathBuf {
    sidecar_dir.join(".venv").join("bin").join("python")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_supervisor_starts_in_not_started_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let supervisor = SearchSidecarSupervisor::new(
            dir.path().join("sidecar.runtime"),
            dir.path().to_path_buf(),
        );
        assert!(matches!(supervisor.state(), SupervisorState::NotStarted));
    }

    #[test]
    fn kill_without_start_transitions_to_stopped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let supervisor = SearchSidecarSupervisor::new(
            dir.path().join("sidecar.runtime"),
            dir.path().to_path_buf(),
        );
        supervisor.kill();
        assert!(matches!(supervisor.state(), SupervisorState::Stopped));
    }

    #[test]
    fn is_terminal_classifies_states_correctly() {
        assert!(!SupervisorState::NotStarted.is_terminal());
        assert!(!SupervisorState::Spawning.is_terminal());
        assert!(!SupervisorState::Failed {
            reason: "x".into(),
            retryable: true,
        }
        .is_terminal());
        assert!(SupervisorState::Failed {
            reason: "x".into(),
            retryable: false,
        }
        .is_terminal());
        assert!(SupervisorState::Stopped.is_terminal());
    }

    #[test]
    fn dev_sidecar_dir_points_at_repo_sidecar_package() {
        let dir = dev_sidecar_dir();
        assert_eq!(
            dir.file_name().and_then(|name| name.to_str()),
            Some("sidecar")
        );
        assert!(dir.join("pyproject.toml").exists());
    }
}
