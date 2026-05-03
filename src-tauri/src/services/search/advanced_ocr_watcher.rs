//! Trigger an auto-reindex of every image node when the advanced-OCR
//! model bundle finishes downloading.
//!
//! Local PP-StructureV3 ships as 13 separate model repos under the
//! ``advanced-ocr-*`` role prefix in the sidecar's manifest. The user
//! can enable the ``advanced-ocr`` feature long before all 13 stages
//! finish downloading; we want existing image nodes to upgrade
//! automatically the moment the pipeline becomes usable, without the
//! user having to click "Reindex" on every folder.
//!
//! Mechanism: every 10 s, fetch ``GET /models/status`` and check
//! whether **every** ``advanced-ocr-*`` role reports ``state="ready"``.
//! On the false → true transition, walk the ``nodes`` table for
//! every file with an image extension and emit a ``node-saved``
//! :class:`VfsChangeEvent` per node. The existing forwarder picks
//! these up and re-enqueues each on the sidecar side.
//!
//! Cloud advanced-OCR doesn't trigger this — there's no download
//! barrier. Users binding to OpenAI / Qwen DashScope can reindex
//! manually via the inspector's Reindex button.
//!
//! Idempotency: we only fan out on the *transition*. If the loop
//! starts with everything already ready (e.g. the user re-launched
//! the app after a successful download in a prior session), we
//! capture that as the initial state and emit nothing.

use std::sync::Arc;
use std::time::Duration;

use crate::infrastructure::db::connection::Database;
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::search::client::SearchSidecarClient;
use crate::services::search::supervisor::{SearchSidecarSupervisor, SupervisorState};
use crate::services::search::SidecarEnvelopeState;
use crate::VfsEventEmitter;

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const ERROR_BACKOFF: Duration = Duration::from_secs(30);
const ROLE_PREFIX: &str = "advanced-ocr-";

/// File-extension allowlist for "is this an image node we want to
/// auto-reindex?" — kept in sync with the sidecar's
/// ``ImageProcessor.SUPPORTED_EXTENSIONS``. Cheap LIKE filter is
/// good enough at the corpus sizes this app targets.
const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif",
];

/// True iff the response carries at least one ``advanced-ocr-*`` role
/// AND every such role is in ``ready`` state.
fn advanced_ocr_all_ready(
    roles: &std::collections::HashMap<
        String,
        crate::services::search::client::ModelRoleStatusDto,
    >,
) -> bool {
    let mut found_any = false;
    for (role, status) in roles.iter() {
        if !role.starts_with(ROLE_PREFIX) {
            continue;
        }
        found_any = true;
        if status.state != "ready" {
            return false;
        }
    }
    found_any
}

/// Find every node whose ``kind="file"`` and whose ``name`` ends in
/// an image extension. Returns an owned ``Vec`` (not an iterator) so
/// the connection can be dropped before we start emitting events —
/// the emitter's downstream forward task may run on the same DB and
/// we don't want to hold a SQLite read lock across that.
pub fn list_image_node_ids(db: &Database) -> rusqlite::Result<Vec<String>> {
    let conn = db.connect()?;
    // Build a single ``... OR ...`` predicate. SQLite's ``LIKE`` is
    // case-insensitive for ASCII by default which matches our intent
    // (``.JPG`` and ``.jpg`` should both match).
    let mut sql = String::from(
        "SELECT id FROM nodes WHERE kind = 'file' AND (",
    );
    let mut params_vec: Vec<String> = Vec::with_capacity(IMAGE_EXTENSIONS.len());
    for (i, ext) in IMAGE_EXTENSIONS.iter().enumerate() {
        if i > 0 {
            sql.push_str(" OR ");
        }
        sql.push_str("name LIKE ?");
        params_vec.push(format!("%{ext}"));
    }
    sql.push(')');
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

/// Long-lived watcher task. Loops until the supervisor is terminally
/// failed (matches the same exit policy as the index-state-sync
/// loop). Survives ``restart_sidecar`` cycles by re-checking state
/// rather than exiting on non-Running.
pub async fn run_advanced_ocr_watcher(
    supervisor: Arc<SearchSidecarSupervisor>,
    client: Arc<SearchSidecarClient>,
    db: Database,
    emitter: VfsEventEmitter,
) {
    log::info!("advanced-ocr-watcher: started (poll={:?})", POLL_INTERVAL);

    // Initial state — captured on the first successful poll. Until
    // then we don't know whether ``all-ready`` is the post-download
    // state or just the pre-existing one, so the first observation
    // seeds the baseline without firing a reindex.
    let mut last_all_ready: Option<bool> = None;

    loop {
        match supervisor.state() {
            SupervisorState::Running { .. } => {}
            SupervisorState::Failed { retryable: false, .. } => {
                log::info!(
                    "advanced-ocr-watcher: supervisor failed terminally; exiting loop"
                );
                return;
            }
            other => {
                log::debug!(
                    "advanced-ocr-watcher: supervisor in {other:?}; waiting for Running"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        }

        let env = client.models_status().await;
        match env.state {
            SidecarEnvelopeState::Ready => {
                let Some(status) = env.data else {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                };
                let now_ready = advanced_ocr_all_ready(&status.roles);
                match last_all_ready {
                    None => {
                        // First observation — seed only.
                        log::debug!(
                            "advanced-ocr-watcher: initial all_ready={now_ready}"
                        );
                        last_all_ready = Some(now_ready);
                    }
                    Some(prev) if !prev && now_ready => {
                        log::info!(
                            "advanced-ocr-watcher: bundle just finished — fanning out reindex"
                        );
                        match list_image_node_ids(&db) {
                            Ok(ids) => {
                                for node_id in &ids {
                                    emitter(VfsChangeEvent {
                                        mount_id: node_id.clone(),
                                        reason: "node-saved".to_string(),
                                        ..Default::default()
                                    });
                                }
                                log::info!(
                                    "advanced-ocr-watcher: reindex fan-out covered {} image node(s)",
                                    ids.len()
                                );
                            }
                            Err(err) => {
                                log::warn!(
                                    "advanced-ocr-watcher: image-node lookup failed: {err}"
                                );
                            }
                        }
                        last_all_ready = Some(true);
                    }
                    Some(_) => {
                        last_all_ready = Some(now_ready);
                    }
                }
            }
            SidecarEnvelopeState::Initialising => {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            SidecarEnvelopeState::Unavailable => {
                log::debug!(
                    "advanced-ocr-watcher: sidecar unavailable ({}); backing off",
                    env.error.as_deref().unwrap_or("(no detail)")
                );
                tokio::time::sleep(ERROR_BACKOFF).await;
                continue;
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::search::client::ModelRoleStatusDto;
    use rusqlite::params;
    use std::collections::HashMap;

    fn role(name: &str, state: &str) -> ModelRoleStatusDto {
        ModelRoleStatusDto {
            role: name.to_string(),
            state: state.to_string(),
            repo: String::new(),
            commit: None,
            license_accepted: false,
            requires_acceptance: false,
            error: None,
        }
    }

    #[test]
    fn all_ready_returns_false_when_no_advanced_ocr_roles_exist() {
        // No advanced-ocr-* roles — must NOT be considered ready
        // (avoids a false trigger on a sidecar that never registered
        // the bundle in the first place).
        let mut roles = HashMap::new();
        roles.insert("embedding".to_string(), role("embedding", "ready"));
        assert!(!advanced_ocr_all_ready(&roles));
    }

    #[test]
    fn all_ready_returns_false_when_one_advanced_role_pending() {
        let mut roles = HashMap::new();
        roles.insert(
            "advanced-ocr-detection".to_string(),
            role("advanced-ocr-detection", "ready"),
        );
        roles.insert(
            "advanced-ocr-recognition".to_string(),
            role("advanced-ocr-recognition", "downloading"),
        );
        assert!(!advanced_ocr_all_ready(&roles));
    }

    #[test]
    fn all_ready_returns_true_when_every_advanced_role_ready() {
        let mut roles = HashMap::new();
        for stage in ["detection", "recognition", "layout"] {
            let key = format!("advanced-ocr-{stage}");
            roles.insert(key.clone(), role(&key, "ready"));
        }
        // Unrelated roles are ignored, even if not ready.
        roles.insert("embedding".to_string(), role("embedding", "missing"));
        assert!(advanced_ocr_all_ready(&roles));
    }

    fn setup_db_with_files(names: &[&str]) -> Database {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        std::mem::forget(dir);
        let db = Database::new(path);
        let conn = db.connect().unwrap();
        for (i, name) in names.iter().enumerate() {
            let id = format!("node-{i}");
            conn.execute(
                "INSERT INTO nodes (id, kind, name, state) VALUES (?1, 'file', ?2, 'ready')",
                params![id, name],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn list_image_node_ids_filters_by_extension() {
        let db = setup_db_with_files(&[
            "photo.png",
            "scan.JPG",  // case-insensitive LIKE
            "doc.pdf",   // not an image
            "vector.svg", // not in our supported list
            "form.bmp",
        ]);
        let mut ids = list_image_node_ids(&db).unwrap();
        ids.sort();
        // Three of the five qualify (png, jpg, bmp).
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn list_image_node_ids_excludes_non_file_kinds() {
        // A directory called "photos.png" should NOT match — we filter
        // on kind='file' first, then on extension.
        let db = setup_db_with_files(&[]);
        let conn = db.connect().unwrap();
        conn.execute(
            "INSERT INTO nodes (id, kind, name, state) VALUES ('dir-1', 'directory', 'photos.png', 'ready')",
            [],
        )
        .unwrap();
        assert!(list_image_node_ids(&db).unwrap().is_empty());
    }
}
