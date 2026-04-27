use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::url_repository::{
    load_url_job, mark_url_error, mark_url_indexed, mark_url_indexing, requeue_stale_jobs,
    UrlJobResult,
};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::url_indexing::cache::write_html_cache;
use crate::services::url_indexing::registry::run_pipeline;

pub struct UrlJobRunner {
    db: Database,
    cache_dir: PathBuf,
    emitter: Arc<dyn Fn(VfsChangeEvent) + Send + Sync>,
    active_jobs: Arc<Mutex<HashSet<String>>>,
}

impl UrlJobRunner {
    pub fn new<F>(db: Database, cache_dir: PathBuf, emitter: F) -> Self
    where
        F: Fn(VfsChangeEvent) + Send + Sync + 'static,
    {
        Self {
            db,
            cache_dir,
            emitter: Arc::new(emitter),
            active_jobs: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn resume_pending_jobs(&self) -> Result<(), String> {
        let conn = self.db.connect().map_err(|error| error.to_string())?;
        let node_ids = requeue_stale_jobs(&conn).map_err(|error| error.to_string())?;
        for node_id in node_ids {
            self.enqueue(node_id)?;
        }
        Ok(())
    }

    pub fn enqueue(&self, node_id: String) -> Result<(), String> {
        {
            let mut active_jobs = self
                .active_jobs
                .lock()
                .map_err(|_| "url job lock poisoned".to_string())?;
            if active_jobs.contains(&node_id) {
                return Ok(());
            }
            active_jobs.insert(node_id.clone());
        }

        let db = self.db.clone();
        let cache_dir = self.cache_dir.clone();
        let emitter = Arc::clone(&self.emitter);
        let active_jobs = Arc::clone(&self.active_jobs);

        std::thread::spawn(move || {
            let result = process_job(&db, &cache_dir, &node_id, &emitter);

            let reason = match result {
                Ok(()) => "url-indexed".to_string(),
                Err(error) => {
                    if let Ok(conn) = db.connect() {
                        let _ = mark_url_error(&conn, &node_id, &error);
                    }
                    "url-error".to_string()
                }
            };

            emitter(VfsChangeEvent {
                mount_id: node_id.clone(),
                reason,
            });

            if let Ok(mut active_jobs) = active_jobs.lock() {
                active_jobs.remove(&node_id);
            }
        });

        Ok(())
    }
}

fn process_job(
    db: &Database,
    cache_dir: &Path,
    node_id: &str,
    emitter: &Arc<dyn Fn(VfsChangeEvent) + Send + Sync>,
) -> Result<(), String> {
    let conn = db.connect().map_err(|error| error.to_string())?;
    let job = load_url_job(&conn, node_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "url job not found".to_string())?;

    mark_url_indexing(&conn, node_id).map_err(|error| error.to_string())?;
    emitter(VfsChangeEvent {
        mount_id: node_id.to_string(),
        reason: "url-indexing".into(),
    });

    let output = run_pipeline(&job.url)?;
    let cache_path = write_html_cache(cache_dir, &job.node_id, &output.html)?;
    let result = UrlJobResult {
        title: output.title,
        description: output.description,
        preview_text: output.preview_text,
        canonical_url: output.canonical_url,
        html_cache_path: cache_path,
    };

    mark_url_indexed(&conn, node_id, &result).map_err(|error| error.to_string())
}
