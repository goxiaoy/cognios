use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTask {
    pub id: String,
    pub node_id: String,
    pub task_type: String,
    pub generation: i64,
    pub attempt: u32,
    pub payload_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTaskStatusCount {
    pub task_type: String,
    pub queued: u64,
    pub running: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub cancelled: u64,
    pub total: u64,
    pub running_node_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundTaskFailure {
    Requeued,
    Failed,
    Stale,
}

pub fn enqueue_background_task(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
    payload: Option<Value>,
    max_attempts: u32,
) -> Result<BackgroundTask, String> {
    let id = Uuid::new_v4().to_string();
    let payload_json = payload.unwrap_or_else(|| serde_json::json!({})).to_string();
    conn.execute(
        "
        INSERT INTO background_tasks (
          id, node_id, task_type, generation, status, attempt,
          max_attempts, payload_json, last_error, locked_at, completed_at
        )
        VALUES (?1, ?2, ?3, 1, 'queued', 0, ?4, ?5, NULL, NULL, NULL)
        ON CONFLICT(node_id, task_type) DO UPDATE SET
          generation = background_tasks.generation + 1,
          status = 'queued',
          attempt = 0,
          max_attempts = excluded.max_attempts,
          payload_json = excluded.payload_json,
          last_error = NULL,
          locked_at = NULL,
          completed_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        ",
        params![id, node_id, task_type, max_attempts, payload_json],
    )
    .map_err(|error| error.to_string())?;
    load_background_task(conn, node_id, task_type)?
        .ok_or_else(|| "background task missing after enqueue".to_string())
}

pub fn enqueue_background_task_if_missing(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
    payload: Option<Value>,
    max_attempts: u32,
) -> Result<Option<BackgroundTask>, String> {
    if background_task_exists(conn, node_id, task_type)? {
        return Ok(None);
    }
    enqueue_background_task(conn, node_id, task_type, payload, max_attempts).map(Some)
}

pub fn enqueue_background_task_if_source_newer(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
    source_timestamp: Option<&str>,
    payload: Option<Value>,
    max_attempts: u32,
) -> Result<Option<BackgroundTask>, String> {
    if !background_task_should_run_for_source(conn, node_id, task_type, source_timestamp)? {
        return Ok(None);
    }
    enqueue_background_task(conn, node_id, task_type, payload, max_attempts).map(Some)
}

pub fn background_task_exists(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
) -> Result<bool, String> {
    conn.query_row(
        "
        SELECT EXISTS(
          SELECT 1
          FROM background_tasks
          WHERE node_id = ?1
            AND task_type = ?2
        )
        ",
        params![node_id, task_type],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|error| error.to_string())
}

fn background_task_should_run_for_source(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
    source_timestamp: Option<&str>,
) -> Result<bool, String> {
    let Some(source_timestamp) = source_timestamp else {
        return background_task_exists(conn, node_id, task_type).map(|exists| !exists);
    };
    conn.query_row(
        "
        SELECT EXISTS(
          SELECT 1
          FROM background_tasks
          WHERE node_id = ?1
            AND task_type = ?2
            AND (
              status IN ('queued', 'running')
              OR (
                completed_at IS NOT NULL
                AND julianday(completed_at) >= julianday(?3)
              )
            )
        )
        ",
        params![node_id, task_type, source_timestamp],
        |row| row.get::<_, i64>(0),
    )
    .map(|covered| covered == 0)
    .map_err(|error| error.to_string())
}

pub fn recover_background_tasks(conn: &Connection, task_type: &str) -> Result<usize, String> {
    conn.execute(
        "
        UPDATE background_tasks
        SET status = 'queued',
            locked_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE task_type = ?1
          AND status = 'running'
        ",
        [task_type],
    )
    .map_err(|error| error.to_string())
}

pub fn queued_background_task_node_ids(
    conn: &Connection,
    task_type: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT node_id
            FROM background_tasks
            WHERE task_type = ?1
              AND status = 'queued'
            ORDER BY updated_at ASC, node_id ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([task_type], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn has_queued_background_tasks(conn: &Connection, task_type: &str) -> Result<bool, String> {
    conn.query_row(
        "
        SELECT EXISTS(
          SELECT 1
          FROM background_tasks
          WHERE task_type = ?1
            AND status = 'queued'
        )
        ",
        [task_type],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|error| error.to_string())
}

pub fn background_task_status_counts(
    conn: &Connection,
) -> Result<Vec<BackgroundTaskStatusCount>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
              task_type,
              SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),
              COUNT(*),
              GROUP_CONCAT(CASE WHEN status = 'running' THEN node_id END)
            FROM background_tasks
            GROUP BY task_type
            ORDER BY task_type ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let running_node_ids = row
                .get::<_, Option<String>>(7)?
                .unwrap_or_default()
                .split(',')
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            Ok(BackgroundTaskStatusCount {
                task_type: row.get(0)?,
                queued: row.get::<_, i64>(1)? as u64,
                running: row.get::<_, i64>(2)? as u64,
                succeeded: row.get::<_, i64>(3)? as u64,
                failed: row.get::<_, i64>(4)? as u64,
                cancelled: row.get::<_, i64>(5)? as u64,
                total: row.get::<_, i64>(6)? as u64,
                running_node_ids,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn claim_next_background_task(
    conn: &Connection,
    task_type: &str,
) -> Result<Option<BackgroundTask>, String> {
    let row = conn
        .query_row(
            "
            SELECT node_id, generation
            FROM background_tasks
            WHERE task_type = ?1
              AND status = 'queued'
            ORDER BY updated_at ASC, node_id ASC
            LIMIT 1
            ",
            [task_type],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((node_id, generation)) = row else {
        return Ok(None);
    };
    claim_background_task_for_node(conn, task_type, &node_id, generation)
}

pub fn claim_queued_background_task_for_node(
    conn: &Connection,
    task_type: &str,
    node_id: &str,
) -> Result<Option<BackgroundTask>, String> {
    let generation = conn
        .query_row(
            "
            SELECT generation
            FROM background_tasks
            WHERE node_id = ?1
              AND task_type = ?2
              AND status = 'queued'
            ",
            params![node_id, task_type],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(generation) = generation else {
        return Ok(None);
    };
    claim_background_task_for_node(conn, task_type, node_id, generation)
}

pub fn claim_background_task_for_node(
    conn: &Connection,
    task_type: &str,
    node_id: &str,
    generation: i64,
) -> Result<Option<BackgroundTask>, String> {
    let changed = conn
        .execute(
            "
            UPDATE background_tasks
            SET status = 'running',
                attempt = attempt + 1,
                locked_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE node_id = ?1
              AND task_type = ?2
              AND generation = ?3
              AND status = 'queued'
            ",
            params![node_id, task_type, generation],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    load_background_task(conn, node_id, task_type)
}

pub fn background_task_is_running(
    conn: &Connection,
    task: &BackgroundTask,
) -> Result<bool, String> {
    conn.query_row(
        "
        SELECT EXISTS(
          SELECT 1
          FROM background_tasks
          WHERE id = ?1
            AND generation = ?2
            AND status = 'running'
        )
        ",
        params![task.id, task.generation],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|error| error.to_string())
}

pub fn complete_background_task(conn: &Connection, task: &BackgroundTask) -> Result<bool, String> {
    conn.execute(
        "
        UPDATE background_tasks
        SET status = 'succeeded',
            last_error = NULL,
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
          AND generation = ?2
          AND status = 'running'
        ",
        params![task.id, task.generation],
    )
    .map(|changed| changed > 0)
    .map_err(|error| error.to_string())
}

pub fn fail_background_task(
    conn: &Connection,
    task: &BackgroundTask,
    message: &str,
    retryable: bool,
) -> Result<BackgroundTaskFailure, String> {
    let row = conn
        .query_row(
            "
            SELECT status, attempt, max_attempts
            FROM background_tasks
            WHERE id = ?1
              AND generation = ?2
            ",
            params![task.id, task.generation],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, attempt, max_attempts)) = row else {
        return Ok(BackgroundTaskFailure::Stale);
    };
    if status != "running" {
        return Ok(BackgroundTaskFailure::Stale);
    }

    let truncated = message.chars().take(1024).collect::<String>();
    if retryable && attempt < max_attempts {
        conn.execute(
            "
            UPDATE background_tasks
            SET status = 'queued',
                last_error = ?3,
                locked_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
              AND generation = ?2
              AND status = 'running'
            ",
            params![task.id, task.generation, truncated],
        )
        .map_err(|error| error.to_string())?;
        return Ok(BackgroundTaskFailure::Requeued);
    }

    conn.execute(
        "
        UPDATE background_tasks
        SET status = 'failed',
            last_error = ?3,
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
          AND generation = ?2
          AND status = 'running'
        ",
        params![task.id, task.generation, truncated],
    )
    .map_err(|error| error.to_string())?;
    Ok(BackgroundTaskFailure::Failed)
}

pub fn defer_background_task(
    conn: &Connection,
    task: &BackgroundTask,
    message: &str,
) -> Result<BackgroundTaskFailure, String> {
    let truncated = message.chars().take(1024).collect::<String>();
    let changed = conn
        .execute(
            "
            UPDATE background_tasks
            SET status = 'queued',
                attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END,
                last_error = ?3,
                locked_at = NULL,
                completed_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
              AND generation = ?2
              AND status = 'running'
            ",
            params![task.id, task.generation, truncated],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Ok(BackgroundTaskFailure::Stale);
    }
    Ok(BackgroundTaskFailure::Requeued)
}

pub fn cancel_background_tasks(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE background_tasks
        SET generation = generation + 1,
            status = 'cancelled',
            locked_at = NULL,
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE node_id = ?1
          AND task_type = ?2
          AND status IN ('queued', 'running')
        ",
        params![node_id, task_type],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn load_background_task(
    conn: &Connection,
    node_id: &str,
    task_type: &str,
) -> Result<Option<BackgroundTask>, String> {
    conn.query_row(
        "
        SELECT id, node_id, task_type, generation, attempt, payload_json
        FROM background_tasks
        WHERE node_id = ?1
          AND task_type = ?2
        ",
        params![node_id, task_type],
        |row| {
            Ok(BackgroundTask {
                id: row.get(0)?,
                node_id: row.get(1)?,
                task_type: row.get(2)?,
                generation: row.get(3)?,
                attempt: row.get::<_, i64>(4)? as u32,
                payload_json: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}
