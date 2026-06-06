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
        id: "content.index",
        label: "Indexing",
        order: 20,
        importance: StageImportance::Required,
    },
];

const FILE_STAGES: &[StageDefinition] = &[StageDefinition {
    id: "content.index",
    label: "Indexing",
    order: 10,
    importance: StageImportance::Required,
}];

const ENHANCEABLE_FILE_STAGES: &[StageDefinition] = &[
    StageDefinition {
        id: "content.index",
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
    id: "content.index",
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
        id: "content.index",
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
    insert_stage_defaults(conn, node_id, definitions)
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
    let mut stmt = conn.prepare("SELECT id FROM nodes ORDER BY id")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut nodes = BTreeMap::new();
    for row in rows {
        let node_id = row?;
        if let Some(status) = get_node_status(conn, &node_id)? {
            nodes.insert(node_id, status);
        }
    }
    Ok(NodeStatusSnapshotDto { revision, nodes })
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
                StageState::Pending.as_str(),
                definition.importance.as_str()
            ],
        )?;
    }
    Ok(())
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
        .or_else(|| stages.iter().find(|stage| stage.state == "pending"))
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
    state == "pending" || state == "failed" || state == "blocked"
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
