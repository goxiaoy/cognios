use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use uuid::Uuid;

use crate::domain::vfs::node::{ExplorerSnapshotDto, NodeKind};
use crate::domain::vfs::state::NodeState;
use crate::infrastructure::db::node_repository::{list_snapshot, touch_node_modified_at};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUrlInput {
    pub url: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryUrlInput {
    pub node_id: String,
}

#[derive(Debug)]
pub struct CreatedUrl {
    pub node_id: String,
    pub snapshot: ExplorerSnapshotDto,
}

#[derive(Clone, Debug)]
pub struct UrlJobRecord {
    pub node_id: String,
    pub url: String,
}

#[derive(Debug)]
pub struct UrlJobResult {
    pub title: Option<String>,
    pub description: Option<String>,
    pub preview_text: String,
    pub canonical_url: Option<String>,
    pub html_cache_path: String,
}

pub fn create_url(conn: &mut Connection, input: &CreateUrlInput) -> rusqlite::Result<CreatedUrl> {
    validate_parent(conn, input.parent_id.as_deref())?;
    let trimmed_url = input.url.trim();
    if trimmed_url.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "url must not be empty".into(),
        ));
    }

    let node_id = Uuid::new_v4().to_string();
    let tx = conn.transaction()?;
    tx.execute(
        "
        INSERT INTO nodes (id, parent_id, kind, name, state, size_bytes)
        VALUES (?1, ?2, ?3, ?4, ?5, 0)
        ",
        params![
            node_id,
            input.parent_id,
            NodeKind::Url.as_str(),
            trimmed_url,
            NodeState::Pending.as_str()
        ],
    )?;
    tx.execute(
        "
        INSERT INTO url_jobs (node_id, url)
        VALUES (?1, ?2)
        ",
        params![node_id, trimmed_url],
    )?;
    tx.commit()?;
    touch_node_modified_at(conn, input.parent_id.as_deref())?;

    Ok(CreatedUrl {
        node_id,
        snapshot: list_snapshot(conn)?,
    })
}

pub fn retry_url(conn: &Connection, input: &RetryUrlInput) -> rusqlite::Result<()> {
    conn.execute(
        "
        UPDATE nodes
        SET state = ?2
        WHERE id = ?1 AND kind = ?3
        ",
        params![
            input.node_id,
            NodeState::Pending.as_str(),
            NodeKind::Url.as_str()
        ],
    )?;
    Ok(())
}

pub fn requeue_stale_jobs(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.execute(
        "
        UPDATE nodes
        SET state = ?1
        WHERE kind = ?2 AND state IN (?3, ?4)
        ",
        params![
            NodeState::Pending.as_str(),
            NodeKind::Url.as_str(),
            NodeState::Indexing.as_str(),
            NodeState::Error.as_str()
        ],
    )?;

    list_pending_job_ids(conn)
}

pub fn list_pending_job_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "
        SELECT id
        FROM nodes
        WHERE kind = ?1 AND state = ?2
        ORDER BY id
        ",
    )?;
    let rows = stmt.query_map(
        params![NodeKind::Url.as_str(), NodeState::Pending.as_str()],
        |row| row.get(0),
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

pub fn load_url_job(conn: &Connection, node_id: &str) -> rusqlite::Result<Option<UrlJobRecord>> {
    conn.query_row(
        "
        SELECT node_id, url
        FROM url_jobs
        WHERE node_id = ?1
        ",
        [node_id],
        |row| {
            Ok(UrlJobRecord {
                node_id: row.get(0)?,
                url: row.get(1)?,
            })
        },
    )
    .optional()
}

pub fn mark_url_indexing(conn: &Connection, node_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE nodes SET state = ?2 WHERE id = ?1",
        params![node_id, NodeState::Indexing.as_str()],
    )?;
    Ok(())
}

pub fn mark_url_indexed(
    conn: &Connection,
    node_id: &str,
    result: &UrlJobResult,
) -> rusqlite::Result<()> {
    let display_name = result
        .title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| result.canonical_url.clone())
        .unwrap_or_else(|| "URL".into());

    let cache_size = std::fs::metadata(&result.html_cache_path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or_default();

    conn.execute(
        "
        UPDATE nodes
        SET state = ?2, name = ?3, updated_at = CURRENT_TIMESTAMP, size_bytes = ?4
        WHERE id = ?1
        ",
        params![
            node_id,
            NodeState::Indexed.as_str(),
            display_name,
            cache_size
        ],
    )?;
    conn.execute(
        "
        UPDATE url_jobs
        SET title = ?2,
            description = ?3,
            preview_text = ?4,
            canonical_url = ?5,
            html_cache_path = ?6,
            last_error = NULL
        WHERE node_id = ?1
        ",
        params![
            node_id,
            result.title,
            result.description,
            result.preview_text,
            result.canonical_url,
            result.html_cache_path
        ],
    )?;
    Ok(())
}

pub fn mark_url_error(conn: &Connection, node_id: &str, message: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE nodes SET state = ?2 WHERE id = ?1",
        params![node_id, NodeState::Error.as_str()],
    )?;
    conn.execute(
        "UPDATE url_jobs SET last_error = ?2 WHERE node_id = ?1",
        params![node_id, message],
    )?;
    Ok(())
}

pub fn delete_url_artifacts(conn: &Connection, node_id: &str) -> rusqlite::Result<()> {
    let html_cache_path: Option<String> = conn
        .query_row(
            "SELECT html_cache_path FROM url_jobs WHERE node_id = ?1",
            [node_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    if let Some(path) = html_cache_path {
        let path = Path::new(&path);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(())
}

fn validate_parent(conn: &Connection, parent_id: Option<&str>) -> rusqlite::Result<()> {
    if let Some(parent_id) = parent_id {
        let mut stmt = conn.prepare("SELECT 1 FROM nodes WHERE id = ?1 LIMIT 1")?;
        let parent_exists = stmt.exists([parent_id])?;
        if !parent_exists {
            return Err(rusqlite::Error::InvalidParameterName(
                "parent node does not exist".into(),
            ));
        }
    }

    Ok(())
}
