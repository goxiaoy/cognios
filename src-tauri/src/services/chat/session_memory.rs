use std::fs;
use std::hash::Hasher;
use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::domain::chat::ChatMessageDto;
use crate::infrastructure::db::chat_repository::list_session_messages;

const STATUS_DIRTY: &str = "dirty";
const STATUS_RUNNING: &str = "running";
const STATUS_READY: &str = "ready";
const STATUS_DELETED: &str = "deleted";
const ROUND_THRESHOLD: i64 = 3;
const TOKEN_THRESHOLD: i64 = 3_000;
const RECENT_MESSAGE_LIMIT: usize = 6;

#[derive(Debug, Clone)]
pub struct MemoryRefreshJob {
    pub session_id: String,
    pub job_id: String,
    pub revision: i64,
    pub previous_memory: Option<String>,
    pub messages: Vec<MemoryRefreshMessage>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub last_message_ordinal: i64,
    pub dirty_round_count: i64,
    pub dirty_token_count: i64,
}

#[derive(Debug, Clone)]
pub struct MemoryRefreshMessage {
    pub role: String,
    pub content: String,
    pub ordinal: i64,
}

#[derive(Debug, Clone)]
pub struct VerifiedMemoryBody {
    pub body: String,
    pub revision: i64,
    pub last_included_message_ordinal: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshReason {
    TurnCompleted,
    SessionSwitch,
    Idle,
}

pub fn memory_root(storage_dir: &Path) -> PathBuf {
    storage_dir.join("session-memory")
}

pub fn record_successful_turn(
    conn: &Connection,
    session_id: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    estimated_tokens: i64,
) -> Result<bool, String> {
    ensure_session_exists(conn, session_id).map_err(|error| error.to_string())?;
    conn.execute(
        "
        INSERT INTO chat_session_memories (
          session_id, status, dirty_round_count, dirty_token_count, provider_id, model_id
        )
        VALUES (?1, ?2, 1, ?3, ?4, ?5)
        ON CONFLICT(session_id) DO UPDATE SET
          status = CASE
            WHEN chat_session_memories.status = 'running' THEN 'running'
            WHEN chat_session_memories.deleted_at IS NOT NULL THEN 'deleted'
            ELSE 'dirty'
          END,
          dirty_round_count = chat_session_memories.dirty_round_count + 1,
          dirty_token_count = chat_session_memories.dirty_token_count + excluded.dirty_token_count,
          provider_id = COALESCE(excluded.provider_id, chat_session_memories.provider_id),
          model_id = COALESCE(excluded.model_id, chat_session_memories.model_id),
          updated_at = CURRENT_TIMESTAMP
        ",
        params![
            session_id,
            STATUS_DIRTY,
            estimated_tokens.max(0),
            provider_id,
            model_id
        ],
    )
    .map_err(|error| error.to_string())?;

    should_schedule_refresh(conn, session_id, RefreshReason::TurnCompleted)
}

pub fn should_schedule_refresh(
    conn: &Connection,
    session_id: &str,
    reason: RefreshReason,
) -> Result<bool, String> {
    let Some(row) = load_memory_row(conn, session_id).map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    if row.status == STATUS_RUNNING || row.status == STATUS_DELETED {
        return Ok(false);
    }
    if row.last_successful_revision == 0 {
        return Ok(row.dirty_round_count > 0 || row.dirty_token_count > 0);
    }
    match reason {
        RefreshReason::TurnCompleted => Ok(
            row.dirty_round_count >= ROUND_THRESHOLD || row.dirty_token_count >= TOKEN_THRESHOLD
        ),
        RefreshReason::SessionSwitch | RefreshReason::Idle => {
            Ok(row.dirty_round_count > 0 || row.dirty_token_count > 0)
        }
    }
}

pub fn begin_refresh(
    conn: &Connection,
    root: &Path,
    session_id: &str,
) -> Result<Option<MemoryRefreshJob>, String> {
    ensure_session_exists(conn, session_id).map_err(|error| error.to_string())?;
    let Some(row) = load_memory_row(conn, session_id).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    if row.status == STATUS_RUNNING || row.status == STATUS_DELETED {
        return Ok(None);
    }
    if row.dirty_round_count <= 0 && row.dirty_token_count <= 0 && row.last_successful_revision > 0
    {
        return Ok(None);
    }

    let messages = list_session_messages(conn, session_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|message| message.ordinal > row.last_included_message_ordinal)
        .map(|message| MemoryRefreshMessage {
            role: message.role,
            content: message.body,
            ordinal: message.ordinal,
        })
        .collect::<Vec<_>>();
    let Some(last_message_ordinal) = messages.iter().map(|message| message.ordinal).max() else {
        return Ok(None);
    };

    let previous_memory = read_verified_body_for_row(root, session_id, &row).ok();
    let job_id = Uuid::new_v4().to_string();
    let revision = row.last_successful_revision + 1;
    conn.execute(
        "
        UPDATE chat_session_memories
        SET status = ?2,
            job_id = ?3,
            memory_revision = ?4,
            updated_at = CURRENT_TIMESTAMP,
            last_error = NULL
        WHERE session_id = ?1 AND deleted_at IS NULL
        ",
        params![session_id, STATUS_RUNNING, job_id, revision],
    )
    .map_err(|error| error.to_string())?;
    let current_row = load_memory_row(conn, session_id).map_err(|error| error.to_string())?;
    if current_row
        .as_ref()
        .and_then(|current| current.job_id.as_deref())
        != Some(job_id.as_str())
    {
        return Ok(None);
    }

    Ok(Some(MemoryRefreshJob {
        session_id: session_id.to_string(),
        job_id,
        revision,
        previous_memory,
        messages,
        provider_id: row.provider_id,
        model_id: row.model_id,
        last_message_ordinal,
        dirty_round_count: row.dirty_round_count,
        dirty_token_count: row.dirty_token_count,
    }))
}

pub fn complete_refresh(
    conn: &Connection,
    root: &Path,
    job: &MemoryRefreshJob,
    body: &str,
    included_message_ordinal: i64,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<i64, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("session memory body must not be empty".into());
    }
    let Some(row) = load_memory_row(conn, &job.session_id).map_err(|error| error.to_string())?
    else {
        cleanup_revision_file(root, &job.session_id, &revision_file_key(job));
        return Err("chat session memory no longer exists".into());
    };
    if row.status != STATUS_RUNNING || row.job_id.as_deref() != Some(job.job_id.as_str()) {
        cleanup_revision_file(root, &job.session_id, &revision_file_key(job));
        return Err("stale session memory refresh".into());
    }
    if job.revision <= row.last_successful_revision {
        cleanup_revision_file(root, &job.session_id, &revision_file_key(job));
        return Err("session memory revision is stale".into());
    }

    let file_key = revision_file_key(job);
    let body_bytes = body.as_bytes();
    let checksum = checksum(body_bytes);
    let path = resolve_memory_path(root, &job.session_id, &file_key)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, body_bytes).map_err(|error| error.to_string())?;

    let changed = conn
        .execute(
            "
        UPDATE chat_session_memories
        SET file_key = ?3,
            last_successful_revision = ?4,
            memory_revision = ?4,
            body_checksum = ?5,
            body_byte_len = ?6,
            body_written_at = CURRENT_TIMESTAMP,
            last_included_message_ordinal = ?7,
            dirty_round_count = MAX(dirty_round_count - ?11, 0),
            dirty_token_count = MAX(dirty_token_count - ?12, 0),
            status = CASE
              WHEN MAX(dirty_round_count - ?11, 0) > 0
                OR MAX(dirty_token_count - ?12, 0) > 0
              THEN 'dirty'
              ELSE ?2
            END,
            provider_id = COALESCE(?8, provider_id),
            model_id = COALESCE(?9, model_id),
            job_id = NULL,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?1
          AND status = 'running'
          AND job_id = ?10
          AND deleted_at IS NULL
        ",
            params![
                job.session_id,
                STATUS_READY,
                file_key,
                job.revision,
                checksum,
                body_bytes.len() as i64,
                included_message_ordinal,
                provider_id,
                model_id,
                job.job_id,
                job.dirty_round_count.max(0),
                job.dirty_token_count.max(0)
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        cleanup_revision_file(root, &job.session_id, &file_key);
        return Err("session memory refresh lost its write race".into());
    }
    if let Some(old_file_key) = row.file_key {
        if old_file_key != file_key {
            cleanup_revision_file(root, &job.session_id, &old_file_key);
        }
    }
    Ok(job.revision)
}

pub fn fail_refresh(conn: &Connection, job: &MemoryRefreshJob, error: &str) -> Result<(), String> {
    conn.execute(
        "
        UPDATE chat_session_memories
        SET status = ?2,
            job_id = NULL,
            last_error = ?3,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?1 AND job_id = ?4 AND deleted_at IS NULL
        ",
        params![job.session_id, STATUS_DIRTY, error, job.job_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn read_verified_body(
    conn: &Connection,
    root: &Path,
    session_id: &str,
) -> Result<Option<VerifiedMemoryBody>, String> {
    let Some(row) = load_memory_row(conn, session_id).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let body = match read_verified_body_for_row(root, session_id, &row) {
        Ok(body) => body,
        Err(_) => return Ok(None),
    };
    Ok(Some(VerifiedMemoryBody {
        body,
        revision: row.last_successful_revision,
        last_included_message_ordinal: row.last_included_message_ordinal,
    }))
}

pub fn bounded_prompt_messages(
    messages: &[ChatMessageDto],
    memory: Option<&VerifiedMemoryBody>,
) -> Vec<ChatMessageDto> {
    let cutoff = memory
        .map(|memory| memory.last_included_message_ordinal)
        .unwrap_or(-1);
    let mut newer = messages
        .iter()
        .filter(|message| message.ordinal > cutoff)
        .cloned()
        .collect::<Vec<_>>();
    if newer.len() >= RECENT_MESSAGE_LIMIT {
        return newer.split_off(newer.len().saturating_sub(RECENT_MESSAGE_LIMIT));
    }

    let needed = RECENT_MESSAGE_LIMIT.saturating_sub(newer.len());
    let older = messages
        .iter()
        .filter(|message| message.ordinal <= cutoff)
        .rev()
        .take(needed)
        .cloned()
        .collect::<Vec<_>>();
    older.into_iter().rev().chain(newer).collect()
}

pub fn delete_session_memory(
    conn: &Connection,
    root: &Path,
    session_id: &str,
) -> Result<(), String> {
    let row = load_memory_row(conn, session_id).map_err(|error| error.to_string())?;
    conn.execute(
        "
        UPDATE chat_session_memories
        SET status = ?2,
            deleted_at = CURRENT_TIMESTAMP,
            job_id = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?1
        ",
        params![session_id, STATUS_DELETED],
    )
    .map_err(|error| error.to_string())?;
    if let Some(row) = row {
        if let Some(file_key) = row.file_key {
            cleanup_revision_file(root, session_id, &file_key);
        }
    }
    let session_dir = root.join(session_id);
    let _ = fs::remove_dir_all(session_dir);
    Ok(())
}

pub fn sanitize_generated_markdown(body: &str) -> String {
    body.replace('<', "&lt;").replace('>', "&gt;")
}

#[allow(dead_code)]
pub fn recover_orphaned_refreshes(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "
        UPDATE chat_session_memories
        SET status = 'dirty',
            job_id = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ?1
          AND status = 'running'
          AND deleted_at IS NULL
        ",
        [session_id],
    )?;
    Ok(())
}

fn read_verified_body_for_row(
    root: &Path,
    session_id: &str,
    row: &MemoryRow,
) -> Result<String, String> {
    if row.last_successful_revision <= 0 {
        return Err("session memory has no successful revision".into());
    }
    let file_key = row
        .file_key
        .as_deref()
        .ok_or_else(|| "session memory file missing".to_string())?;
    let expected_checksum = row
        .body_checksum
        .as_deref()
        .ok_or_else(|| "session memory checksum missing".to_string())?;
    let path = resolve_memory_path(root, session_id, file_key)?;
    let body = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let bytes = body.as_bytes();
    if checksum(bytes) != expected_checksum {
        return Err("session memory checksum mismatch".into());
    }
    if row.body_byte_len.unwrap_or(-1) != bytes.len() as i64 {
        return Err("session memory length mismatch".into());
    }
    Ok(body)
}

fn resolve_memory_path(root: &Path, session_id: &str, file_key: &str) -> Result<PathBuf, String> {
    validate_path_segment(session_id, "session id")?;
    validate_path_segment(file_key, "session memory file key")?;
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let session_dir = canonical_root.join(session_id);
    if let Ok(metadata) = fs::symlink_metadata(&session_dir) {
        if metadata.file_type().is_symlink() {
            return Err("session memory directory must not be a symlink".into());
        }
    }
    fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
    let canonical_session = fs::canonicalize(&session_dir).map_err(|error| error.to_string())?;
    if !canonical_session.starts_with(&canonical_root) {
        return Err("session memory path escaped the internal root".into());
    }

    let path = canonical_session.join(file_key);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err("session memory file must not be a symlink".into());
        }
        let canonical_path = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("session memory file escaped the internal root".into());
        }
    }
    Ok(path)
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{label} must be an opaque path segment"));
    }
    Ok(())
}

fn revision_file_key(job: &MemoryRefreshJob) -> String {
    format!("rev-{}-{}.md", job.revision, job.job_id)
}

fn cleanup_revision_file(root: &Path, session_id: &str, file_key: &str) {
    if let Ok(path) = resolve_memory_path(root, session_id, file_key) {
        let _ = fs::remove_file(path);
    }
}

fn checksum(bytes: &[u8]) -> String {
    let mut hash = Fnv1a64::default();
    hash.write(bytes);
    format!("{:016x}", hash.finish())
}

#[derive(Default)]
struct Fnv1a64(u64);

impl Hasher for Fnv1a64 {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut hash = if self.0 == 0 {
            0xcbf29ce484222325
        } else {
            self.0
        };
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        self.0 = hash;
    }
}

fn estimated_tokens(text: &str) -> i64 {
    ((text.chars().count() as i64) / 4).max(1)
}

pub fn estimated_message_tokens(messages: &[MemoryRefreshMessage]) -> i64 {
    messages
        .iter()
        .map(|message| estimated_tokens(&message.content))
        .sum()
}

pub fn estimate_text_tokens(text: &str) -> i64 {
    estimated_tokens(text)
}

fn ensure_session_exists(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM chat_sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidParameterName(
            "chat session does not exist".into(),
        ))
    }
}

#[derive(Debug)]
struct MemoryRow {
    status: String,
    file_key: Option<String>,
    last_successful_revision: i64,
    body_checksum: Option<String>,
    body_byte_len: Option<i64>,
    last_included_message_ordinal: i64,
    dirty_round_count: i64,
    dirty_token_count: i64,
    provider_id: Option<String>,
    model_id: Option<String>,
    job_id: Option<String>,
}

fn load_memory_row(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<MemoryRow>> {
    conn.query_row(
        "
        SELECT status, file_key, last_successful_revision, body_checksum,
               body_byte_len, last_included_message_ordinal, dirty_round_count,
               dirty_token_count, provider_id, model_id, job_id
        FROM chat_session_memories
        WHERE session_id = ?1 AND deleted_at IS NULL
        ",
        [session_id],
        |row| {
            Ok(MemoryRow {
                status: row.get(0)?,
                file_key: row.get(1)?,
                last_successful_revision: row.get(2)?,
                body_checksum: row.get(3)?,
                body_byte_len: row.get(4)?,
                last_included_message_ordinal: row.get(5)?,
                dirty_round_count: row.get(6)?,
                dirty_token_count: row.get(7)?,
                provider_id: row.get(8)?,
                model_id: row.get(9)?,
                job_id: row.get(10)?,
            })
        },
    )
    .optional()
}
