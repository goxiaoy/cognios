use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::chat::{
    ChatMessageDto, ChatSessionDetailDto, ChatSessionDto, ChatSourceClusterDto,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatSessionInput {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendChatMessageInput {
    pub session_id: String,
    pub role: String,
    pub body: String,
    #[serde(default)]
    pub metadata_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindChatNoteInput {
    pub session_id: String,
    pub note_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatSessionTitleInput {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordChatClusterInput {
    pub session_id: String,
    #[serde(default)]
    pub turn_message_id: Option<String>,
    pub title: String,
    pub source_kind: String,
    pub status: String,
    pub summary: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub sources_json: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteChatSessionResult {
    pub deleted: bool,
}

pub fn create_session(
    conn: &Connection,
    input: &CreateChatSessionInput,
) -> rusqlite::Result<ChatSessionDto> {
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("New chat");
    let session_id = Uuid::new_v4().to_string();

    conn.execute(
        "
        INSERT INTO chat_sessions (id, title)
        VALUES (?1, ?2)
        ",
        params![session_id, title],
    )?;

    get_session(conn, &session_id)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("created chat session missing".into()))
}

pub fn list_sessions(conn: &Connection) -> rusqlite::Result<Vec<ChatSessionDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, title, bound_note_id, created_at, updated_at
        FROM chat_sessions
        ORDER BY updated_at DESC, created_at DESC
        ",
    )?;

    let sessions = stmt
        .query_map([], map_session)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sessions)
}

pub fn get_session(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<ChatSessionDto>> {
    conn.query_row(
        "
        SELECT id, title, bound_note_id, created_at, updated_at
        FROM chat_sessions
        WHERE id = ?1
        ",
        [session_id],
        map_session,
    )
    .optional()
}

pub fn get_session_detail(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<ChatSessionDetailDto>> {
    let Some(session) = get_session(conn, session_id)? else {
        return Ok(None);
    };

    Ok(Some(ChatSessionDetailDto {
        session,
        messages: list_messages(conn, session_id)?,
        clusters: list_clusters(conn, session_id)?,
    }))
}

pub fn append_message(
    conn: &Connection,
    input: &AppendChatMessageInput,
) -> rusqlite::Result<ChatMessageDto> {
    let role = normalise_role(&input.role)?;
    let body = input.body.trim();
    if body.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "chat message body must not be empty".into(),
        ));
    }
    ensure_session_exists(conn, &input.session_id)?;
    let metadata_json = normalise_json_object(input.metadata_json.as_deref())?;
    let ordinal = next_message_ordinal(conn, &input.session_id)?;
    let message_id = Uuid::new_v4().to_string();

    conn.execute(
        "
        INSERT INTO chat_messages (id, session_id, role, body, ordinal, metadata_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ",
        params![
            message_id,
            input.session_id,
            role,
            body,
            ordinal,
            metadata_json
        ],
    )?;
    touch_session(conn, &input.session_id)?;

    get_message(conn, &message_id)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("created chat message missing".into()))
}

pub fn record_cluster(
    conn: &Connection,
    input: &RecordChatClusterInput,
) -> rusqlite::Result<ChatSourceClusterDto> {
    ensure_session_exists(conn, &input.session_id)?;
    let title = input.title.trim();
    if title.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "chat cluster title must not be empty".into(),
        ));
    }
    let source_kind = normalise_source_kind(&input.source_kind)?;
    let status = normalise_cluster_status(&input.status)?;
    let summary = input.summary.trim();
    let sources_json = normalise_json_array(input.sources_json.as_deref())?;
    let cluster_id = Uuid::new_v4().to_string();

    conn.execute(
        "
        INSERT INTO chat_source_clusters (
          id, session_id, turn_message_id, title, source_kind, status, summary, score, sources_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
        params![
            cluster_id,
            input.session_id,
            input.turn_message_id,
            title,
            source_kind,
            status,
            summary,
            input.score,
            sources_json
        ],
    )?;
    touch_session(conn, &input.session_id)?;

    get_cluster(conn, &cluster_id)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("created chat cluster missing".into()))
}

pub fn bind_note(conn: &Connection, input: &BindChatNoteInput) -> rusqlite::Result<ChatSessionDto> {
    ensure_session_exists(conn, &input.session_id)?;
    let note_exists = conn.query_row(
        "SELECT 1 FROM nodes WHERE id = ?1 AND kind = 'note' LIMIT 1",
        [&input.note_id],
        |_| Ok(()),
    );
    if note_exists.optional()?.is_none() {
        return Err(rusqlite::Error::InvalidParameterName(
            "bound chat note does not exist".into(),
        ));
    }

    conn.execute(
        "
        UPDATE chat_sessions
        SET bound_note_id = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![input.session_id, input.note_id],
    )?;

    get_session(conn, &input.session_id)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("updated chat session missing".into()))
}

pub fn delete_session(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<DeleteChatSessionResult> {
    let rows = conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [session_id])?;
    Ok(DeleteChatSessionResult { deleted: rows > 0 })
}

pub fn update_session_title(
    conn: &Connection,
    input: &UpdateChatSessionTitleInput,
) -> rusqlite::Result<ChatSessionDto> {
    ensure_session_exists(conn, &input.session_id)?;
    let title = input.title.trim();
    if title.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "chat session title must not be empty".into(),
        ));
    }

    conn.execute(
        "
        UPDATE chat_sessions
        SET title = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![input.session_id, title],
    )?;

    get_session(conn, &input.session_id)?
        .ok_or_else(|| rusqlite::Error::InvalidParameterName("updated chat session missing".into()))
}

fn list_messages(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<ChatMessageDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, session_id, role, body, ordinal, metadata_json, created_at
        FROM chat_messages
        WHERE session_id = ?1
        ORDER BY ordinal ASC
        ",
    )?;
    let messages = stmt
        .query_map([session_id], map_message)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(messages)
}

fn list_clusters(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Vec<ChatSourceClusterDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, session_id, turn_message_id, title, source_kind, status, summary, score, sources_json, created_at
        FROM chat_source_clusters
        WHERE session_id = ?1
        ORDER BY created_at ASC, id ASC
        ",
    )?;
    let clusters = stmt
        .query_map([session_id], map_cluster)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(clusters)
}

fn get_message(conn: &Connection, message_id: &str) -> rusqlite::Result<Option<ChatMessageDto>> {
    conn.query_row(
        "
        SELECT id, session_id, role, body, ordinal, metadata_json, created_at
        FROM chat_messages
        WHERE id = ?1
        ",
        [message_id],
        map_message,
    )
    .optional()
}

fn get_cluster(
    conn: &Connection,
    cluster_id: &str,
) -> rusqlite::Result<Option<ChatSourceClusterDto>> {
    conn.query_row(
        "
        SELECT id, session_id, turn_message_id, title, source_kind, status, summary, score, sources_json, created_at
        FROM chat_source_clusters
        WHERE id = ?1
        ",
        [cluster_id],
        map_cluster,
    )
    .optional()
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

fn next_message_ordinal(conn: &Connection, session_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM chat_messages WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )
}

fn touch_session(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [session_id],
    )?;
    Ok(())
}

fn normalise_role(role: &str) -> rusqlite::Result<&'static str> {
    match role {
        "user" => Ok("user"),
        "assistant" => Ok("assistant"),
        "system" => Ok("system"),
        _ => Err(rusqlite::Error::InvalidParameterName(
            "unsupported chat message role".into(),
        )),
    }
}

fn normalise_source_kind(source_kind: &str) -> rusqlite::Result<&'static str> {
    match source_kind {
        "workspace" => Ok("workspace"),
        "web" => Ok("web"),
        "mixed" => Ok("mixed"),
        _ => Err(rusqlite::Error::InvalidParameterName(
            "unsupported chat source kind".into(),
        )),
    }
}

fn normalise_cluster_status(status: &str) -> rusqlite::Result<&'static str> {
    match status {
        "candidate" => Ok("candidate"),
        "accepted" => Ok("accepted"),
        "excluded" => Ok("excluded"),
        "suggested" => Ok("suggested"),
        _ => Err(rusqlite::Error::InvalidParameterName(
            "unsupported chat cluster status".into(),
        )),
    }
}

fn normalise_json_object(value: Option<&str>) -> rusqlite::Result<String> {
    normalise_json(
        value,
        "{}",
        |json| json.is_object(),
        "metadata_json must be an object",
    )
}

fn normalise_json_array(value: Option<&str>) -> rusqlite::Result<String> {
    normalise_json(
        value,
        "[]",
        |json| json.is_array(),
        "sources_json must be an array",
    )
}

fn normalise_json(
    value: Option<&str>,
    fallback: &str,
    predicate: impl Fn(&serde_json::Value) -> bool,
    error: &str,
) -> rusqlite::Result<String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(fallback.to_string());
    };
    let json: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| rusqlite::Error::InvalidParameterName(error.into()))?;
    if !predicate(&json) {
        return Err(rusqlite::Error::InvalidParameterName(error.into()));
    }
    Ok(json.to_string())
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSessionDto> {
    Ok(ChatSessionDto {
        id: row.get(0)?,
        title: row.get(1)?,
        bound_note_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn map_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessageDto> {
    Ok(ChatMessageDto {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        body: row.get(3)?,
        ordinal: row.get(4)?,
        metadata_json: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn map_cluster(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSourceClusterDto> {
    Ok(ChatSourceClusterDto {
        id: row.get(0)?,
        session_id: row.get(1)?,
        turn_message_id: row.get(2)?,
        title: row.get(3)?,
        source_kind: row.get(4)?,
        status: row.get(5)?,
        summary: row.get(6)?,
        score: row.get(7)?,
        sources_json: row.get(8)?,
        created_at: row.get(9)?,
    })
}
