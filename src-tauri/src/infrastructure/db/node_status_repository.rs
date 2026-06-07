use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::node_status::{
    NodeStageErrorDto, NodeStageStatusDto, NodeStatusChangedEventDto, NodeStatusOverall,
    NodeStatusSnapshotDto, NodeStatusViewDto, StageDefinition, StageImportance, StageState,
    StageUpdate,
};

const URL_STAGES: &[StageDefinition] = &[
    StageDefinition {
        id: "url.crawl",
        label: "Crawling",
        order: 10,
        importance: StageImportance::Required,
    },
    StageDefinition {
        id: "search.index",
        label: "Indexing",
        order: 20,
        importance: StageImportance::Required,
    },
];

const FILE_STAGES: &[StageDefinition] = &[StageDefinition {
    id: "search.index",
    label: "Indexing",
    order: 10,
    importance: StageImportance::Required,
}];

const ENHANCEABLE_FILE_STAGES: &[StageDefinition] = &[
    StageDefinition {
        id: "search.index",
        label: "Indexing",
        order: 10,
        importance: StageImportance::Required,
    },
    StageDefinition {
        id: "image.enhance",
        label: "Enhancing",
        order: 20,
        importance: StageImportance::Optional,
    },
];

const NOTE_STAGES: &[StageDefinition] = &[StageDefinition {
    id: "search.index",
    label: "Indexing",
    order: 10,
    importance: StageImportance::Required,
}];

const VOICE_NOTE_STAGES: &[StageDefinition] = &[
    StageDefinition {
        id: "voice.transcribe",
        label: "Transcribing",
        order: 10,
        importance: StageImportance::Required,
    },
    StageDefinition {
        id: "voice.summarize",
        label: "Summarizing",
        order: 20,
        importance: StageImportance::Optional,
    },
    StageDefinition {
        id: "search.index",
        label: "Indexing",
        order: 30,
        importance: StageImportance::Required,
    },
];

pub const NODE_STATUS_CHANGED_EVENT: &str = "node-status://changed";

pub fn ensure_default_stages_for_node(conn: &Connection, node_id: &str) -> rusqlite::Result<()> {
    let Some(definitions) = default_stage_definitions(conn, node_id)? else {
        return Ok(());
    };
    insert_stage_defaults(conn, node_id, definitions)?;
    reconcile_stage_defaults(conn, node_id)
}

pub fn ensure_default_stages_for_all_nodes(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("SELECT id FROM nodes ORDER BY id")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        ensure_default_stages_for_node(conn, &row?)?;
    }
    Ok(())
}

pub fn update_stage(
    conn: &Connection,
    node_id: &str,
    stage_id: &str,
    update: &StageUpdate,
) -> rusqlite::Result<(u64, NodeStatusViewDto)> {
    ensure_default_stages_for_node(conn, node_id)?;
    let Some(definition) = stage_definition_for_node(conn, node_id, stage_id)? else {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unsupported node status stage {stage_id}"
        )));
    };
    let detail_json = update
        .detail
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let started_at_expr = if update.started_at.is_some() {
        "COALESCE(started_at, CURRENT_TIMESTAMP)"
    } else {
        "started_at"
    };
    let finished_at_expr = if update.finished_at.is_some() {
        "CURRENT_TIMESTAMP"
    } else {
        "finished_at"
    };
    let sql = format!(
        "
        INSERT INTO node_statuses (
          node_id, stage_id, label, stage_order, state, importance,
          message, detail_json, error_message, retryable, attempt,
          started_at, finished_at, updated_at
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          ?7, ?8, ?9, ?10, COALESCE(?11, 0),
          CASE WHEN ?12 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
          CASE WHEN ?13 = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(node_id, stage_id) DO UPDATE SET
          label = excluded.label,
          stage_order = excluded.stage_order,
          state = excluded.state,
          importance = excluded.importance,
          message = excluded.message,
          detail_json = COALESCE(excluded.detail_json, node_statuses.detail_json),
          error_message = excluded.error_message,
          retryable = excluded.retryable,
          attempt = COALESCE(?11, node_statuses.attempt),
          started_at = {started_at_expr},
          finished_at = {finished_at_expr},
          updated_at = CURRENT_TIMESTAMP
        ",
    );
    conn.execute(
        &sql,
        params![
            node_id,
            stage_id,
            definition.label,
            definition.order,
            update.state.as_str(),
            definition.importance.as_str(),
            update.message,
            detail_json,
            update.error_message,
            update.retryable as i64,
            update.attempt,
            update.started_at.is_some() as i64,
            update.finished_at.is_some() as i64,
        ],
    )?;
    let revision = bump_revision(conn)?;
    let status = get_node_status(conn, node_id)?.ok_or_else(|| {
        rusqlite::Error::InvalidParameterName(format!("node status missing for {node_id}"))
    })?;
    Ok((revision, status))
}

pub fn get_node_status(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Option<NodeStatusViewDto>> {
    ensure_default_stages_for_node(conn, node_id)?;
    let exists = conn
        .query_row("SELECT 1 FROM nodes WHERE id = ?1", [node_id], |_| Ok(()))
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }
    let stages = list_stages_for_node(conn, node_id)?;
    Ok(Some(derive_node_status_view(node_id.to_string(), stages)))
}

pub fn get_node_status_snapshot(conn: &Connection) -> rusqlite::Result<NodeStatusSnapshotDto> {
    ensure_default_stages_for_all_nodes(conn)?;
    let revision = current_revision(conn)?;
    let mut stmt = conn.prepare(
        "
        SELECT
          n.id,
          s.stage_id,
          s.label,
          s.state,
          s.importance,
          s.message,
          s.detail_json,
          s.error_message,
          s.retryable,
          s.attempt,
          s.started_at,
          s.finished_at,
          s.updated_at
        FROM nodes n
        LEFT JOIN node_statuses s ON s.node_id = n.id
        ORDER BY n.id ASC, s.stage_order ASC, s.stage_id ASC
        ",
    )?;
    let mut rows = stmt.query([])?;
    let mut grouped: BTreeMap<String, Vec<NodeStageStatusDto>> = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let node_id: String = row.get(0)?;
        let stages = grouped.entry(node_id).or_default();
        if row.get::<_, Option<String>>(1)?.is_some() {
            stages.push(stage_from_snapshot_row(row)?);
        }
    }
    let nodes = grouped
        .into_iter()
        .map(|(node_id, stages)| {
            let status = derive_node_status_view(node_id.clone(), stages);
            (node_id, status)
        })
        .collect();
    Ok(NodeStatusSnapshotDto { revision, nodes })
}

pub fn node_supports_stage(
    conn: &Connection,
    node_id: &str,
    stage_id: &str,
) -> rusqlite::Result<bool> {
    Ok(stage_definition_for_node(conn, node_id, stage_id)?.is_some())
}

pub fn get_node_status_changed_event(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Option<NodeStatusChangedEventDto>> {
    let revision = current_revision(conn)?;
    Ok(
        get_node_status(conn, node_id)?.map(|status| NodeStatusChangedEventDto {
            revision,
            node_id: node_id.to_string(),
            status,
        }),
    )
}

fn insert_stage_defaults(
    conn: &Connection,
    node_id: &str,
    definitions: &[StageDefinition],
) -> rusqlite::Result<()> {
    for definition in definitions {
        conn.execute(
            "
            INSERT OR IGNORE INTO node_statuses (
              node_id, stage_id, label, stage_order, state, importance
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ",
            params![
                node_id,
                definition.id,
                definition.label,
                definition.order,
                default_state_for_definition(definition).as_str(),
                definition.importance.as_str()
            ],
        )?;
    }
    Ok(())
}

fn default_state_for_definition(definition: &StageDefinition) -> StageState {
    match definition.importance {
        StageImportance::Optional => StageState::Skipped,
        StageImportance::Required => StageState::Pending,
    }
}

fn reconcile_stage_defaults(conn: &Connection, node_id: &str) -> rusqlite::Result<()> {
    let row = conn
        .query_row(
            "
            SELECT n.kind, n.state, EXISTS(SELECT 1 FROM voice_notes v WHERE v.note_id = n.id)
            FROM nodes n
            WHERE n.id = ?1
            ",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? == 1,
                ))
            },
        )
        .optional()?;
    let Some((kind, node_state, is_voice_note)) = row else {
        return Ok(());
    };

    let mut changed = 0;
    match kind.as_str() {
        "url" => {
            changed += reconcile_url_stages(conn, node_id, &node_state)?;
        }
        "file" => {
            changed += reconcile_index_stage_from_node_state(conn, node_id, &node_state)?;
            changed += update_stage_row(
                conn,
                node_id,
                "image.enhance",
                &StageUpdate {
                    state: StageState::Skipped,
                    message: Some("Enhancement not run".to_string()),
                    detail: None,
                    error_message: None,
                    retryable: false,
                    attempt: None,
                    started_at: None,
                    finished_at: Some("CURRENT_TIMESTAMP".to_string()),
                },
            )?;
        }
        "note" if is_voice_note => {
            changed += reconcile_voice_note_stages(conn, node_id, &node_state)?;
        }
        "note" => {
            changed += reconcile_index_stage_from_node_state(conn, node_id, &node_state)?;
        }
        _ => {}
    }
    if changed > 0 {
        let _ = bump_revision(conn)?;
    }
    Ok(())
}

fn reconcile_url_stages(
    conn: &Connection,
    node_id: &str,
    node_state: &str,
) -> rusqlite::Result<usize> {
    let row = conn
        .query_row(
            "
            SELECT title, description, preview_text, canonical_url, html_cache_path, last_error
            FROM urls
            WHERE node_id = ?1
            ",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let mut changed = 0;
    if let Some((title, description, preview_text, canonical_url, html_cache_path, last_error)) =
        row
    {
        let has_crawled_content = html_cache_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .is_some()
            || preview_text
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .is_some();
        if has_crawled_content || node_state == "indexed" {
            changed += update_stage_row(
                conn,
                node_id,
                "url.crawl",
                &StageUpdate {
                    state: StageState::Succeeded,
                    message: Some("Crawl succeeded".to_string()),
                    detail: Some(serde_json::json!({
                        "title": title,
                        "canonicalUrl": canonical_url,
                        "description": description,
                        "htmlCachePath": html_cache_path,
                    })),
                    error_message: None,
                    retryable: false,
                    attempt: None,
                    started_at: None,
                    finished_at: Some("CURRENT_TIMESTAMP".to_string()),
                },
            )?;
        } else if node_state == "error" {
            changed += update_stage_row(
                conn,
                node_id,
                "url.crawl",
                &StageUpdate::failed(
                    last_error.unwrap_or_else(|| "Crawl failed".to_string()),
                    true,
                ),
            )?;
        }
    }
    changed += reconcile_index_stage_from_node_state(conn, node_id, node_state)?;
    Ok(changed)
}

fn reconcile_voice_note_stages(
    conn: &Connection,
    node_id: &str,
    node_state: &str,
) -> rusqlite::Result<usize> {
    let row = conn
        .query_row(
            "
            SELECT capture_status, transcription_status, summary_status, transcript_updated_at
            FROM voice_notes
            WHERE note_id = ?1
            ",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((capture_status, transcription_status, summary_status, transcript_updated_at)) = row
    else {
        return Ok(0);
    };

    let mut changed = 0;
    let transcribe_update = match transcription_status.as_str() {
        "completed" => Some(StageUpdate::succeeded("Transcript completed")),
        "transcribing" if capture_status == "recording" => {
            Some(StageUpdate::running("Transcribing"))
        }
        "transcribing" if transcript_updated_at.is_some() => {
            Some(StageUpdate::succeeded("Transcript completed"))
        }
        "transcribing" => Some(StageUpdate::failed("Transcription did not complete", true)),
        "failed" => Some(StageUpdate::failed("Transcription failed", false)),
        "unavailable" => Some(StageUpdate {
            state: StageState::Skipped,
            message: Some("Transcription unavailable".to_string()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        }),
        _ => None,
    };
    if let Some(update) = transcribe_update {
        changed += update_stage_row(conn, node_id, "voice.transcribe", &update)?;
    }

    let summary_update = match summary_status.as_str() {
        "ready" => Some(StageUpdate::succeeded("Summary ready")),
        "pending" => Some(StageUpdate::running("Summarizing")),
        "failed" => Some(StageUpdate::failed("Summary failed", true)),
        _ => None,
    };
    if let Some(update) = summary_update {
        changed += update_stage_row(conn, node_id, "voice.summarize", &update)?;
    }
    changed += reconcile_index_stage_from_node_state(conn, node_id, node_state)?;
    Ok(changed)
}

fn reconcile_index_stage_from_node_state(
    conn: &Connection,
    node_id: &str,
    node_state: &str,
) -> rusqlite::Result<usize> {
    let update = match node_state {
        "indexed" => Some(StageUpdate::succeeded("Indexed")),
        "indexing" => Some(StageUpdate::running("Indexing")),
        "unsupported" => Some(StageUpdate {
            state: StageState::Skipped,
            message: Some("No index processor available".to_string()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        }),
        "error" => Some(StageUpdate::failed("Indexing failed", true)),
        _ => None,
    };
    match update {
        Some(update) => update_stage_row(conn, node_id, "search.index", &update),
        None => Ok(0),
    }
}

fn update_stage_row(
    conn: &Connection,
    node_id: &str,
    stage_id: &str,
    update: &StageUpdate,
) -> rusqlite::Result<usize> {
    let detail_json = update
        .detail
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let message_key = update.message.as_deref().unwrap_or_default();
    let error_key = update.error_message.as_deref().unwrap_or_default();
    conn.execute(
        "
        UPDATE node_statuses
        SET state = ?3,
            message = ?4,
            detail_json = COALESCE(?5, detail_json),
            error_message = ?6,
            retryable = ?7,
            attempt = COALESCE(?8, attempt),
            started_at = CASE WHEN ?9 = 1 THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
            finished_at = CASE WHEN ?10 = 1 THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE finished_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE node_id = ?1
          AND stage_id = ?2
          AND (
            state != ?3
            OR COALESCE(message, '') != ?11
            OR COALESCE(error_message, '') != ?12
            OR retryable != ?7
            OR (?5 IS NOT NULL AND COALESCE(detail_json, '') != ?5)
            OR (?9 = 1 AND started_at IS NULL)
            OR (?10 = 1 AND finished_at IS NULL)
          )
        ",
        params![
            node_id,
            stage_id,
            update.state.as_str(),
            update.message,
            detail_json,
            update.error_message,
            update.retryable as i64,
            update.attempt,
            update.started_at.is_some() as i64,
            update.finished_at.is_some() as i64,
            message_key,
            error_key,
        ],
    )
}

fn default_stage_definitions(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Option<&'static [StageDefinition]>> {
    let row = conn
        .query_row(
            "
            SELECT n.kind, n.name, EXISTS(SELECT 1 FROM voice_notes v WHERE v.note_id = n.id)
            FROM nodes n
            WHERE n.id = ?1
            ",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? == 1,
                ))
            },
        )
        .optional()?;
    let Some((kind, name, is_voice_note)) = row else {
        return Ok(None);
    };
    let definitions = match kind.as_str() {
        "url" => URL_STAGES,
        "file" if is_enhanceable_file(&name) => ENHANCEABLE_FILE_STAGES,
        "file" => FILE_STAGES,
        "note" if is_voice_note => VOICE_NOTE_STAGES,
        "note" => NOTE_STAGES,
        "folder" | "mount" | "directory" => &[],
        _ => &[],
    };
    Ok(Some(definitions))
}

fn stage_definition_for_node(
    conn: &Connection,
    node_id: &str,
    stage_id: &str,
) -> rusqlite::Result<Option<StageDefinition>> {
    let Some(definitions) = default_stage_definitions(conn, node_id)? else {
        return Ok(None);
    };
    Ok(definitions
        .iter()
        .copied()
        .find(|stage| stage.id == stage_id))
}

fn is_enhanceable_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn list_stages_for_node(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Vec<NodeStageStatusDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT stage_id, label, state, importance, message, detail_json,
               error_message, retryable, attempt, started_at, finished_at, updated_at
        FROM node_statuses
        WHERE node_id = ?1
        ORDER BY stage_order ASC, stage_id ASC
        ",
    )?;
    let rows = stmt.query_map([node_id], |row| {
        let detail_json: Option<String> = row.get(5)?;
        let detail = detail_json
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok());
        let error_message: Option<String> = row.get(6)?;
        Ok(NodeStageStatusDto {
            id: row.get(0)?,
            label: row.get(1)?,
            state: StageState::from_db(&row.get::<_, String>(2)?)
                .as_str()
                .to_string(),
            importance: StageImportance::from_db(&row.get::<_, String>(3)?)
                .as_str()
                .to_string(),
            message: row.get(4)?,
            detail,
            error: error_message.map(|message| NodeStageErrorDto {
                message,
                retryable: row.get::<_, i64>(7).unwrap_or_default() != 0,
            }),
            attempt: row.get::<_, i64>(8).unwrap_or_default().max(0) as u32,
            started_at: row.get(9)?,
            finished_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;
    rows.collect()
}

fn stage_from_snapshot_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodeStageStatusDto> {
    let detail_json: Option<String> = row.get(6)?;
    let detail = detail_json
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok());
    let error_message: Option<String> = row.get(7)?;
    Ok(NodeStageStatusDto {
        id: row.get(1)?,
        label: row.get(2)?,
        state: StageState::from_db(&row.get::<_, String>(3)?)
            .as_str()
            .to_string(),
        importance: StageImportance::from_db(&row.get::<_, String>(4)?)
            .as_str()
            .to_string(),
        message: row.get(5)?,
        detail,
        error: error_message.map(|message| NodeStageErrorDto {
            message,
            retryable: row.get::<_, i64>(8).unwrap_or_default() != 0,
        }),
        attempt: row.get::<_, i64>(9).unwrap_or_default().max(0) as u32,
        started_at: row.get(10)?,
        finished_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn derive_node_status_view(node_id: String, stages: Vec<NodeStageStatusDto>) -> NodeStatusViewDto {
    if stages.is_empty() {
        return NodeStatusViewDto {
            node_id,
            overall: NodeStatusOverall::Idle.as_str().to_string(),
            primary_stage_id: None,
            stages,
            updated_at: "".to_string(),
        };
    }
    let primary_stage_id = select_primary_stage(&stages).map(|stage| stage.id.clone());
    let overall = derive_overall(&stages);
    let updated_at = stages
        .iter()
        .map(|stage| stage.updated_at.as_str())
        .max()
        .unwrap_or_default()
        .to_string();
    NodeStatusViewDto {
        node_id,
        overall: overall.as_str().to_string(),
        primary_stage_id,
        stages,
        updated_at,
    }
}

fn select_primary_stage(stages: &[NodeStageStatusDto]) -> Option<&NodeStageStatusDto> {
    stages
        .iter()
        .find(|stage| stage.state == "running")
        .or_else(|| {
            stages
                .iter()
                .find(|stage| stage.importance == "required" && stage.state == "failed")
        })
        .or_else(|| stages.iter().find(|stage| stage.state == "failed"))
        .or_else(|| {
            stages
                .iter()
                .find(|stage| stage.importance == "required" && stage.state == "pending")
        })
}

fn derive_overall(stages: &[NodeStageStatusDto]) -> NodeStatusOverall {
    if stages.iter().any(|stage| stage.state == "running") {
        return NodeStatusOverall::Running;
    }
    if stages
        .iter()
        .any(|stage| stage.importance == "required" && is_failed_like(&stage.state))
    {
        return NodeStatusOverall::Failed;
    }
    if stages
        .iter()
        .any(|stage| stage.importance == "required" && stage.state == "pending")
    {
        return NodeStatusOverall::Queued;
    }
    if stages
        .iter()
        .any(|stage| stage.importance == "optional" && is_incomplete_or_failed(&stage.state))
    {
        return NodeStatusOverall::Partial;
    }
    if stages
        .iter()
        .any(|stage| stage.importance == "required" && stage.state == "succeeded")
    {
        return NodeStatusOverall::Ready;
    }
    NodeStatusOverall::Unsupported
}

fn is_failed_like(state: &str) -> bool {
    state == "failed" || state == "blocked"
}

fn is_incomplete_or_failed(state: &str) -> bool {
    state == "failed" || state == "blocked"
}

fn current_revision(conn: &Connection) -> rusqlite::Result<u64> {
    conn.query_row(
        "SELECT revision FROM node_status_revisions WHERE id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value.max(0) as u64)
}

fn bump_revision(conn: &Connection) -> rusqlite::Result<u64> {
    conn.execute(
        "UPDATE node_status_revisions SET revision = revision + 1 WHERE id = 1",
        [],
    )?;
    current_revision(conn)
}
