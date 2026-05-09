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
//! 3. `stop_gracefully()` sends SIGTERM to the sidecar and waits for
//!    the Python lifecycle cleanup path before falling back to SIGKILL.
//!
//! If no candidate can be spawned, `start()` transitions to `Failed` and
//! logs the attempted launch paths — the rest of the app continues to work.
//! Search and captioning are simply unavailable.

#[cfg(debug_assertions)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_shell::process::{Command, CommandChild};
use tauri_plugin_shell::ShellExt;

use super::runtime_file::{read_runtime_file, RuntimeFile, RuntimeFileError};

const RUNTIME_POLL_INTERVAL: Duration = Duration::from_secs(1);
const RUNTIME_READY_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_BINARY_NAME: &str = "search-sidecar";

// Native OCR shutdown is cooperative: Python handles SIGTERM on the
// main thread, asks the runner to stop, then waits for any in-flight
// Paddle enhancement call to return. Keep this comfortably above the
// expected 5-15 s PP-StructureV3 init/extract window so dev restarts
// do not hard-kill Python mid-native-call and trigger macOS crash UI.
const ORPHAN_SIGTERM_GRACE: Duration = Duration::from_secs(90);
const ORPHAN_POLL_INTERVAL: Duration = Duration::from_millis(100);

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
    lock_path: PathBuf,
    storage_dir: PathBuf,
}

struct Inner {
    state: SupervisorState,
    child: Option<CommandChild>,
}

impl SearchSidecarSupervisor {
    /// `runtime_path` = `~/.cogios/search/sidecar.runtime`
    /// `storage_dir` = `~/.cogios` (the sidecar's `--storage-dir` arg)
    ///
    /// `sidecar.lock` is derived from `runtime_path`'s parent directory.
    /// It carries the holder's PID so this supervisor can SIGTERM an
    /// orphaned sidecar (e.g. from a crashed `tauri dev` session) on
    /// next start.
    pub fn new(runtime_path: PathBuf, storage_dir: PathBuf) -> Self {
        let lock_path = runtime_path
            .parent()
            .map(|dir| dir.join("sidecar.lock"))
            .unwrap_or_else(|| PathBuf::from("sidecar.lock"));
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: SupervisorState::NotStarted,
                child: None,
            })),
            runtime_path,
            lock_path,
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

        // Pre-spawn orphan cleanup: if a previous sidecar is still
        // alive (e.g. survived a `tauri dev` Ctrl-C that didn't reach
        // the child), SIGTERM it so the new spawn can acquire the
        // flock. Safe in production too — if no orphan exists this is
        // a no-op.
        terminate_orphan_if_alive(&self.lock_path);

        // Defensive: remove any stale runtime file before the
        // polling task starts. If the previous sidecar was SIGKILL'd
        // (orphan path that fell through to KILL, or a hard crash)
        // its lifecycle.py ``finally`` block didn't run, so the file
        // points at a now-dead port. Without this delete the polling
        // task succeeds on its first read with the OLD ``(port,
        // token)``, the supervisor reports Running, and the first
        // request hits a refused connection ("network: error sending
        // request"). The new sidecar still writes a fresh file moments
        // later but the supervisor never re-reads.
        if let Err(err) = std::fs::remove_file(&self.runtime_path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "supervisor: failed to remove stale runtime file at {}: {}",
                    self.runtime_path.display(),
                    err
                );
            }
        }

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

    /// Stop the running sidecar via SIGTERM, falling back to SIGKILL
    /// only if the process is still alive after the grace period.
    pub fn kill(&self) {
        self.stop_gracefully();
    }

    pub fn stop_gracefully(&self) {
        self.terminate_current_child("stop", ORPHAN_SIGTERM_GRACE);
        self.set_state(SupervisorState::Stopped);
    }

    pub fn stop_gracefully_with_timeout(&self, sigterm_grace: Duration) {
        self.terminate_current_child("stop", sigterm_grace);
        self.set_state(SupervisorState::Stopped);
    }

    /// Stop the running sidecar (graceful SIGTERM, fall back to
    /// SIGKILL after a grace period) and re-spawn it with the same
    /// arguments. Used when settings change in a way that requires
    /// the sidecar to re-wire its dispatcher (provider swap, feature
    /// toggle, etc. — see ``Mixed-provider data corruption guard``
    /// in the plan).
    ///
    /// Sequence:
    /// 1. Read the holder PID from ``sidecar.lock`` so we can poll
    ///    its liveness directly (the in-memory ``Stopped`` state set
    ///    by ``kill()`` is synchronous and tells us nothing about
    ///    the OS process).
    /// 2. Send SIGTERM via the existing ``send_signal`` helper. The
    ///    sidecar's ``lifecycle.py`` SIGTERM handler runs the
    ///    ``finally`` block that drains the runner and releases the
    ///    flock cleanly.
    /// 3. Poll for the process to exit, up to ``ORPHAN_SIGTERM_GRACE``.
    /// 4. If still alive, fall back to ``child.kill()`` (SIGKILL) +
    ///    one more poll round for the kernel to reap.
    /// 5. Spawn a new sidecar via ``start(app)``.
    pub fn restart(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        self.terminate_current_child("restart", ORPHAN_SIGTERM_GRACE);
        self.set_state(SupervisorState::Stopped);
        // Spawn fresh.
        self.start(app);
        Ok(())
    }

    fn terminate_current_child(&self, context: &str, sigterm_grace: Duration) {
        let pid_before = read_lock_holder_pid(&self.lock_path);

        // Send SIGTERM if we know who's holding the lock.
        if let Some(pid) = pid_before {
            if process_is_alive(pid) {
                if let Err(err) = send_signal(pid, "TERM") {
                    log::warn!("{context}: SIGTERM to pid {pid} failed: {err}");
                }
                // Wait for graceful exit + flock release.
                let deadline = Instant::now() + sigterm_grace;
                while Instant::now() < deadline {
                    if !process_is_alive(pid) {
                        break;
                    }
                    sleep(ORPHAN_POLL_INTERVAL);
                }
            }
        }

        // Drop our handle to the child if any. This sends SIGKILL
        // on Unix via tauri-plugin-shell — covers the case where
        // SIGTERM didn't take.
        if let Some(child) = self.take_child() {
            let child_still_alive = pid_before
                .map(process_is_alive)
                .unwrap_or_else(|| process_still_alive_for_child(&child));
            if child_still_alive {
                if let Err(err) = child.kill() {
                    log::warn!("{context}: child.kill() failed: {err}");
                }
            }
        }

        // One more poll to be sure the lock is released before we
        // try to re-acquire it.
        if let Some(pid) = pid_before {
            let deadline = Instant::now() + sigterm_grace;
            while Instant::now() < deadline {
                if !process_is_alive(pid) {
                    break;
                }
                sleep(ORPHAN_POLL_INTERVAL);
            }
        }
    }
}

/// Best-effort liveness check on the child handle. The
/// ``CommandChild`` API doesn't expose ``try_wait``-equivalent in
/// every Tauri version; we conservatively assume alive so the
/// caller still issues kill() — kill on a dead handle is a no-op.
fn process_still_alive_for_child(_child: &CommandChild) -> bool {
    true
}

// ----- orphan-process cleanup ----------------------------------------------

/// If ``sidecar.lock`` names a live PID, send it SIGTERM and wait up
/// to ``ORPHAN_SIGTERM_GRACE`` for it to exit. Falls back to SIGKILL.
/// All branches are best-effort; on any failure we proceed and let
/// the sidecar's own flock guard report the conflict.
fn terminate_orphan_if_alive(lock_path: &std::path::Path) {
    let Some(pid) = read_lock_holder_pid(lock_path) else {
        return;
    };
    if !process_is_alive(pid) {
        return;
    }
    log::info!(
        "found existing search-sidecar at pid {pid} (likely from a prior session); sending SIGTERM"
    );
    if let Err(err) = send_signal(pid, "TERM") {
        log::warn!("kill -TERM {pid} failed: {err}; will try SIGKILL");
    }

    let deadline = std::time::Instant::now() + ORPHAN_SIGTERM_GRACE;
    while std::time::Instant::now() < deadline {
        if !process_is_alive(pid) {
            log::info!("orphan pid {pid} exited cleanly after SIGTERM");
            return;
        }
        sleep(ORPHAN_POLL_INTERVAL);
    }

    log::warn!("orphan pid {pid} did not exit within {ORPHAN_SIGTERM_GRACE:?}; sending SIGKILL");
    if let Err(err) = send_signal(pid, "KILL") {
        log::warn!("kill -KILL {pid} failed: {err}");
    }
}

fn read_lock_holder_pid(lock_path: &std::path::Path) -> Option<i32> {
    let body = std::fs::read_to_string(lock_path).ok()?;
    body.trim().parse::<i32>().ok().filter(|&p| p > 1)
}

fn process_is_alive(pid: i32) -> bool {
    use std::process::Stdio;
    StdCommand::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn send_signal(pid: i32, signal: &str) -> std::io::Result<()> {
    let status = StdCommand::new("kill")
        .args(["-s", signal, &pid.to_string()])
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "kill -{signal} {pid} exited with {status}"
        )));
    }
    Ok(())
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
        let mut uv_command = app.shell().command("uv").current_dir(&sidecar_dir).args([
            "run",
            "search-sidecar",
            "serve",
            "--storage-dir",
            storage_dir,
        ]);
        for (key, value) in dev_sidecar_env() {
            uv_command = uv_command.env(key, value);
        }
        candidates.push(SidecarCommandCandidate {
            label: "local Python sidecar via uv",
            command: uv_command,
        });

        let venv_python = dev_venv_python_path(&sidecar_dir);
        if venv_python.exists() {
            let mut venv_command = app
                .shell()
                .command(venv_python)
                .current_dir(&sidecar_dir)
                .args([
                    "-m",
                    "search_sidecar",
                    "serve",
                    "--storage-dir",
                    storage_dir,
                ]);
            for (key, value) in dev_sidecar_env() {
                venv_command = venv_command.env(key, value);
            }
            candidates.push(SidecarCommandCandidate {
                label: "local Python sidecar via sidecar/.venv",
                command: venv_command,
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

#[cfg(debug_assertions)]
fn dev_sidecar_env() -> Vec<(&'static str, String)> {
    vec![(
        "COGNIOS_ADVANCED_OCR_AUTORUN",
        std::env::var("COGNIOS_ADVANCED_OCR_AUTORUN").unwrap_or_else(|_| "1".to_string()),
    )]
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
    fn read_lock_holder_pid_parses_trailing_newline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sidecar.lock");
        std::fs::write(&path, "12345\n").expect("write");
        assert_eq!(read_lock_holder_pid(&path), Some(12345));
    }

    #[test]
    fn read_lock_holder_pid_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_lock_holder_pid(&dir.path().join("absent.lock")), None);
    }

    #[test]
    fn read_lock_holder_pid_rejects_garbage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sidecar.lock");
        std::fs::write(&path, "not a pid").expect("write");
        assert_eq!(read_lock_holder_pid(&path), None);
    }

    #[test]
    fn read_lock_holder_pid_rejects_pid_under_2() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sidecar.lock");
        std::fs::write(&path, "0").expect("write");
        assert_eq!(read_lock_holder_pid(&path), None);
        std::fs::write(&path, "1").expect("write");
        assert_eq!(read_lock_holder_pid(&path), None);
    }

    #[test]
    fn process_is_alive_returns_true_for_self() {
        assert!(process_is_alive(std::process::id() as i32));
    }

    #[test]
    fn process_is_alive_returns_false_for_unallocated_pid() {
        // PID 99999999 is not allocatable on any modern Unix; pid_max
        // tops out below this on macOS / Linux.
        assert!(!process_is_alive(99_999_999));
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

    #[test]
    fn dev_sidecar_env_enables_advanced_ocr_autorun_by_default() {
        let expected =
            std::env::var("COGNIOS_ADVANCED_OCR_AUTORUN").unwrap_or_else(|_| "1".to_string());
        assert!(dev_sidecar_env()
            .iter()
            .any(|(key, value)| *key == "COGNIOS_ADVANCED_OCR_AUTORUN" && *value == expected));
    }
}
