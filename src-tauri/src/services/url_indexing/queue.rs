use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::infrastructure::db::background_task_repository::{
    claim_queued_background_task_for_node, complete_background_task, enqueue_background_task,
    fail_background_task, queued_background_task_node_ids, recover_background_tasks,
};
use crate::infrastructure::db::connection::Database;
use crate::infrastructure::db::url_repository::{
    load_url, mark_url_error, mark_url_indexed, mark_url_indexing, UrlJobResult,
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

const URL_CRAWL_TASK_TYPE: &str = "url.crawl";

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
        recover_background_tasks(&conn, URL_CRAWL_TASK_TYPE)?;
        let node_ids = queued_background_task_node_ids(&conn, URL_CRAWL_TASK_TYPE)?;
        for node_id in node_ids {
            self.spawn(node_id)?;
        }
        Ok(())
    }

    pub fn enqueue(&self, node_id: String) -> Result<(), String> {
        let conn = self.db.connect().map_err(|error| error.to_string())?;
        enqueue_background_task(&conn, &node_id, URL_CRAWL_TASK_TYPE, None, 3)?;
        drop(conn);
        self.spawn(node_id)
    }

    fn spawn(&self, node_id: String) -> Result<(), String> {
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
                ..Default::default()
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
    let task = match claim_queued_background_task_for_node(&conn, URL_CRAWL_TASK_TYPE, node_id)? {
        Some(task) => task,
        None => return Ok(()),
    };

    let result = (|| {
        let job = load_url(&conn, node_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "url metadata not found".to_string())?;

        mark_url_indexing(&conn, node_id).map_err(|error| error.to_string())?;
        emitter(VfsChangeEvent {
            mount_id: node_id.to_string(),
            reason: "url-indexing".into(),
            ..Default::default()
        });

        let output = run_pipeline(&job.url)?;
        let cache_path = write_html_cache(cache_dir, &job.node_id, &output.html)?;
        let indexed = UrlJobResult {
            title: output.title,
            description: output.description,
            preview_text: output.preview_text,
            canonical_url: output.canonical_url,
            html_cache_path: cache_path,
        };
        mark_url_indexed(&conn, node_id, &indexed).map_err(|error| error.to_string())
    })();

    match result {
        Ok(()) => {
            complete_background_task(&conn, &task)?;
            Ok(())
        }
        Err(error) => {
            let _ = fail_background_task(&conn, &task, &error, true);
            Err(error)
        }
    }
}
