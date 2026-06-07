use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::domain::topic_memory::{
    TopicMemoryCitationDto, TopicMemoryDetailDto, TopicMemoryDto, TopicMemoryItemDto,
    TopicMemoryProposalDto, TopicMemoryRefreshResultDto, TopicMemoryRelationshipDto,
    TopicMemorySourceDto,
};

const ACTIVE: &str = "active";
const ARCHIVED: &str = "archived";
const PENDING: &str = "pending";
const DISMISSED: &str = "dismissed";
const ACCEPTED: &str = "accepted";
const AUTO_APPLY_SOURCE_CONFIDENCE: f64 = 0.82;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicProposalBatchInput {
    #[serde(default)]
    pub topics: Vec<TopicProposalInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicProposalInput {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub sources: Vec<SourceProposalInput>,
    #[serde(default)]
    pub claims: Vec<ItemProposalInput>,
    #[serde(default)]
    pub events: Vec<ItemProposalInput>,
    #[serde(default)]
    pub relationships: Vec<RelationshipProposalInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProposalInput {
    pub node_id: String,
    pub node_title: String,
    #[serde(default)]
    pub node_kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub chunk_id: Option<String>,
    #[serde(default)]
    pub chunk_role: Option<String>,
    #[serde(default)]
    pub anchor_label: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub timestamp_ms: Option<u64>,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProposalInput {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub citation: Option<TopicMemoryCitationDto>,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipProposalInput {
    pub source_label: String,
    pub target_label: String,
    pub relation_type: String,
    #[serde(default)]
    pub citation: Option<TopicMemoryCitationDto>,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryInput {
    pub topic_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicProposalActionInput {
    pub proposal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTopicInput {
    pub topic_id: String,
}

pub fn list_topics(conn: &Connection) -> rusqlite::Result<Vec<TopicMemoryDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, title, summary, status, confidence, rationale, created_at, updated_at
        FROM topic_memories
        WHERE status != ?1
        ORDER BY updated_at DESC, title ASC
        ",
    )?;
    let topics = stmt
        .query_map([ARCHIVED], map_topic)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(topics)
}

pub fn get_topic_detail(
    conn: &Connection,
    topic_id: &str,
) -> rusqlite::Result<Option<TopicMemoryDetailDto>> {
    let Some(topic) = get_topic(conn, topic_id)? else {
        return Ok(None);
    };
    Ok(Some(TopicMemoryDetailDto {
        topic,
        sources: list_sources(conn, topic_id)?,
        items: list_items(conn, topic_id)?,
        relationships: list_relationships(conn, topic_id)?,
        proposals: list_proposals(conn, topic_id)?,
    }))
}

pub fn archive_topic(conn: &Connection, topic_id: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "
        UPDATE topic_memories
        SET status = ?2, archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![topic_id, ARCHIVED],
    )?;
    Ok(changed > 0)
}

pub fn apply_topic_proposals(
    conn: &Connection,
    batch: &TopicProposalBatchInput,
) -> rusqlite::Result<TopicMemoryRefreshResultDto> {
    let mut result = TopicMemoryRefreshResultDto {
        topics_created: 0,
        topics_updated: 0,
        sources_applied: 0,
        proposals_created: 0,
    };
    for topic in &batch.topics {
        let title = topic.title.trim();
        if title.is_empty() {
            continue;
        }
        let normalized = normalize_title(title);
        let existing = get_topic_by_normalized_title(conn, &normalized)?;
        let topic_id = if let Some(existing) = existing {
            conn.execute(
                "
                UPDATE topic_memories
                SET summary = CASE WHEN length(?2) > 0 THEN ?2 ELSE summary END,
                    confidence = MAX(confidence, ?3),
                    rationale = CASE WHEN length(?4) > 0 THEN ?4 ELSE rationale END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?1
                ",
                params![
                    existing.id,
                    topic.summary.trim(),
                    topic.confidence,
                    topic.rationale.trim()
                ],
            )?;
            result.topics_updated += 1;
            existing.id
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "
                INSERT INTO topic_memories (id, title, normalized_title, summary, confidence, rationale)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ",
                params![id, title, normalized, topic.summary.trim(), topic.confidence, topic.rationale.trim()],
            )?;
            result.topics_created += 1;
            id
        };

        for source in &topic.sources {
            if source.node_id.trim().is_empty() || source.node_title.trim().is_empty() {
                continue;
            }
            let signature = source
                .signature
                .clone()
                .unwrap_or_else(|| source_signature(&topic_id, source));
            if source.confidence >= AUTO_APPLY_SOURCE_CONFIDENCE
                && !proposal_signature_dismissed(conn, &signature)?
            {
                upsert_source(conn, &topic_id, source, &signature)?;
                result.sources_applied += 1;
            } else {
                result.proposals_created += insert_proposal(
                    conn,
                    Some(&topic_id),
                    "source",
                    &source.node_title,
                    source.confidence,
                    &source.rationale,
                    &signature,
                    serde_json::to_value(source).unwrap_or(Value::Null),
                )?;
            }
        }

        for claim in &topic.claims {
            result.proposals_created += insert_item_proposal(conn, &topic_id, "claim", claim)?;
        }
        for event in &topic.events {
            result.proposals_created += insert_item_proposal(conn, &topic_id, "event", event)?;
        }
        for relationship in &topic.relationships {
            result.proposals_created +=
                insert_relationship_proposal(conn, &topic_id, relationship)?;
        }
    }
    Ok(result)
}

pub fn accept_proposal(
    conn: &Connection,
    proposal_id: &str,
) -> rusqlite::Result<Option<TopicMemoryDetailDto>> {
    let Some(proposal) = load_pending_proposal(conn, proposal_id)? else {
        return Ok(None);
    };
    let Some(topic_id) = proposal.topic_id.clone() else {
        return Ok(None);
    };
    let body: Value = serde_json::from_str(&proposal.body_json).unwrap_or(Value::Null);
    let applied = match proposal.proposal_type.as_str() {
        "source" => serde_json::from_value::<SourceProposalInput>(body)
            .map(|input| upsert_source(conn, &topic_id, &input, &proposal.signature))
            .ok(),
        "claim" | "event" => serde_json::from_value::<ItemProposalInput>(body)
            .map(|input| {
                insert_item(
                    conn,
                    &topic_id,
                    &proposal.proposal_type,
                    &input,
                    &proposal.signature,
                )
            })
            .ok(),
        "relationship" => serde_json::from_value::<RelationshipProposalInput>(body)
            .map(|input| insert_relationship(conn, &topic_id, &input, &proposal.signature))
            .ok(),
        _ => None,
    };
    let Some(applied) = applied else {
        return Ok(None);
    };
    applied?;
    conn.execute(
        "
        UPDATE topic_memory_proposals
        SET status = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
        ",
        params![proposal_id, ACCEPTED],
    )?;
    get_topic_detail(conn, &topic_id)
}

pub fn dismiss_proposal(conn: &Connection, proposal_id: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "
        UPDATE topic_memory_proposals
        SET status = ?2, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1 AND status = ?3
        ",
        params![proposal_id, DISMISSED, PENDING],
    )?;
    Ok(changed > 0)
}

fn get_topic(conn: &Connection, topic_id: &str) -> rusqlite::Result<Option<TopicMemoryDto>> {
    conn.query_row(
        "
        SELECT id, title, summary, status, confidence, rationale, created_at, updated_at
        FROM topic_memories
        WHERE id = ?1
        ",
        [topic_id],
        map_topic,
    )
    .optional()
}

fn get_topic_by_normalized_title(
    conn: &Connection,
    normalized_title: &str,
) -> rusqlite::Result<Option<TopicMemoryDto>> {
    conn.query_row(
        "
        SELECT id, title, summary, status, confidence, rationale, created_at, updated_at
        FROM topic_memories
        WHERE normalized_title = ?1 AND status != ?2
        ",
        params![normalized_title, ARCHIVED],
        map_topic,
    )
    .optional()
}

fn list_sources(conn: &Connection, topic_id: &str) -> rusqlite::Result<Vec<TopicMemorySourceDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, topic_id, node_id, node_title, node_kind, path, chunk_id, chunk_role,
               anchor_label, citation_json, status, confidence, rationale, created_at, updated_at
        FROM topic_memory_sources
        WHERE topic_id = ?1 AND status = ?2
        ORDER BY confidence DESC, updated_at DESC
        ",
    )?;
    let sources = stmt
        .query_map(params![topic_id, ACTIVE], map_source)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(sources)
}

fn list_items(conn: &Connection, topic_id: &str) -> rusqlite::Result<Vec<TopicMemoryItemDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, topic_id, item_type, title, body, occurred_at, citation_json, status,
               confidence, rationale, created_at, updated_at
        FROM topic_memory_items
        WHERE topic_id = ?1 AND status = ?2
        ORDER BY COALESCE(occurred_at, created_at) DESC, confidence DESC
        ",
    )?;
    let items = stmt
        .query_map(params![topic_id, ACTIVE], map_item)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

fn list_relationships(
    conn: &Connection,
    topic_id: &str,
) -> rusqlite::Result<Vec<TopicMemoryRelationshipDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, topic_id, source_label, target_label, relation_type, citation_json,
               status, confidence, rationale, created_at, updated_at
        FROM topic_memory_relationships
        WHERE topic_id = ?1 AND status = ?2
        ORDER BY confidence DESC, updated_at DESC
        ",
    )?;
    let relationships = stmt
        .query_map(params![topic_id, ACTIVE], map_relationship)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(relationships)
}

fn list_proposals(
    conn: &Connection,
    topic_id: &str,
) -> rusqlite::Result<Vec<TopicMemoryProposalDto>> {
    let mut stmt = conn.prepare(
        "
        SELECT id, topic_id, proposal_type, title, body_json, status, confidence,
               rationale, signature, created_at, updated_at
        FROM topic_memory_proposals
        WHERE topic_id = ?1 AND status = ?2
        ORDER BY confidence DESC, updated_at DESC
        ",
    )?;
    let proposals = stmt
        .query_map(params![topic_id, PENDING], map_proposal)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(proposals)
}

fn load_pending_proposal(
    conn: &Connection,
    proposal_id: &str,
) -> rusqlite::Result<Option<TopicMemoryProposalDto>> {
    conn.query_row(
        "
        SELECT id, topic_id, proposal_type, title, body_json, status, confidence,
               rationale, signature, created_at, updated_at
        FROM topic_memory_proposals
        WHERE id = ?1 AND status = ?2
        ",
        params![proposal_id, PENDING],
        map_proposal,
    )
    .optional()
}

fn upsert_source(
    conn: &Connection,
    topic_id: &str,
    source: &SourceProposalInput,
    signature: &str,
) -> rusqlite::Result<()> {
    let citation = citation_from_source(source);
    let citation_json = to_json(&citation)?;
    conn.execute(
        "
        INSERT INTO topic_memory_sources (
          id, topic_id, node_id, node_title, node_kind, path, chunk_id, chunk_role,
          anchor_label, citation_json, confidence, rationale, signature
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(topic_id, signature) DO UPDATE SET
          node_title = excluded.node_title,
          node_kind = excluded.node_kind,
          path = excluded.path,
          chunk_id = excluded.chunk_id,
          chunk_role = excluded.chunk_role,
          anchor_label = excluded.anchor_label,
          citation_json = excluded.citation_json,
          status = ?14,
          confidence = MAX(topic_memory_sources.confidence, excluded.confidence),
          rationale = excluded.rationale,
          updated_at = CURRENT_TIMESTAMP
        ",
        params![
            Uuid::new_v4().to_string(),
            topic_id,
            source.node_id.trim(),
            source.node_title.trim(),
            source.node_kind.trim(),
            source.path,
            source.chunk_id,
            source.chunk_role,
            source.anchor_label,
            citation_json,
            source.confidence,
            source.rationale.trim(),
            signature,
            ACTIVE
        ],
    )?;
    Ok(())
}

fn insert_item_proposal(
    conn: &Connection,
    topic_id: &str,
    item_type: &str,
    input: &ItemProposalInput,
) -> rusqlite::Result<u32> {
    let signature = input
        .signature
        .clone()
        .unwrap_or_else(|| item_signature(topic_id, item_type, input));
    insert_proposal(
        conn,
        Some(topic_id),
        item_type,
        &input.title,
        input.confidence,
        &input.rationale,
        &signature,
        serde_json::to_value(input).unwrap_or(Value::Null),
    )
}

fn insert_relationship_proposal(
    conn: &Connection,
    topic_id: &str,
    input: &RelationshipProposalInput,
) -> rusqlite::Result<u32> {
    let signature = input
        .signature
        .clone()
        .unwrap_or_else(|| relationship_signature(topic_id, input));
    insert_proposal(
        conn,
        Some(topic_id),
        "relationship",
        &format!("{} -> {}", input.source_label, input.target_label),
        input.confidence,
        &input.rationale,
        &signature,
        serde_json::to_value(input).unwrap_or(Value::Null),
    )
}

fn insert_item(
    conn: &Connection,
    topic_id: &str,
    item_type: &str,
    input: &ItemProposalInput,
    signature: &str,
) -> rusqlite::Result<()> {
    let citation_json = to_json(&input.citation.clone().unwrap_or_else(empty_citation))?;
    conn.execute(
        "
        INSERT INTO topic_memory_items (
          id, topic_id, item_type, title, body, occurred_at, citation_json,
          status, confidence, rationale, signature
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(topic_id, item_type, signature) DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          occurred_at = excluded.occurred_at,
          citation_json = excluded.citation_json,
          status = ?8,
          confidence = MAX(topic_memory_items.confidence, excluded.confidence),
          rationale = excluded.rationale,
          updated_at = CURRENT_TIMESTAMP
        ",
        params![
            Uuid::new_v4().to_string(),
            topic_id,
            item_type,
            input.title.trim(),
            input.body.trim(),
            input.occurred_at,
            citation_json,
            ACTIVE,
            input.confidence,
            input.rationale.trim(),
            signature
        ],
    )?;
    Ok(())
}

fn insert_relationship(
    conn: &Connection,
    topic_id: &str,
    input: &RelationshipProposalInput,
    signature: &str,
) -> rusqlite::Result<()> {
    let citation_json = to_json(&input.citation.clone().unwrap_or_else(empty_citation))?;
    conn.execute(
        "
        INSERT INTO topic_memory_relationships (
          id, topic_id, source_label, target_label, relation_type, citation_json,
          status, confidence, rationale, signature
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(topic_id, signature) DO UPDATE SET
          source_label = excluded.source_label,
          target_label = excluded.target_label,
          relation_type = excluded.relation_type,
          citation_json = excluded.citation_json,
          status = ?7,
          confidence = MAX(topic_memory_relationships.confidence, excluded.confidence),
          rationale = excluded.rationale,
          updated_at = CURRENT_TIMESTAMP
        ",
        params![
            Uuid::new_v4().to_string(),
            topic_id,
            input.source_label.trim(),
            input.target_label.trim(),
            input.relation_type.trim(),
            citation_json,
            ACTIVE,
            input.confidence,
            input.rationale.trim(),
            signature
        ],
    )?;
    Ok(())
}

fn insert_proposal(
    conn: &Connection,
    topic_id: Option<&str>,
    proposal_type: &str,
    title: &str,
    confidence: f64,
    rationale: &str,
    signature: &str,
    body: Value,
) -> rusqlite::Result<u32> {
    if proposal_signature_dismissed(conn, signature)? {
        return Ok(0);
    }
    let body_json = serde_json::to_string(&body)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
    let changed = conn.execute(
        "
        INSERT INTO topic_memory_proposals (
          id, topic_id, proposal_type, title, body_json, confidence, rationale, signature
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(signature) DO UPDATE SET
          title = excluded.title,
          body_json = excluded.body_json,
          confidence = MAX(topic_memory_proposals.confidence, excluded.confidence),
          rationale = excluded.rationale,
          updated_at = CURRENT_TIMESTAMP
        WHERE topic_memory_proposals.status = ?9
        ",
        params![
            Uuid::new_v4().to_string(),
            topic_id,
            proposal_type,
            title.trim(),
            body_json,
            confidence,
            rationale.trim(),
            signature,
            PENDING
        ],
    )?;
    Ok(u32::from(changed > 0))
}

fn proposal_signature_dismissed(conn: &Connection, signature: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM topic_memory_proposals WHERE signature = ?1 AND status = ?2 LIMIT 1",
        params![signature, DISMISSED],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
}

fn map_topic(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicMemoryDto> {
    Ok(TopicMemoryDto {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        status: row.get(3)?,
        confidence: row.get(4)?,
        rationale: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicMemorySourceDto> {
    let citation_json: String = row.get(9)?;
    let citation = parse_citation(&citation_json);
    Ok(TopicMemorySourceDto {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        node_id: row.get(2)?,
        node_title: row.get(3)?,
        node_kind: row.get(4)?,
        path: row.get(5)?,
        chunk_id: row.get(6)?,
        chunk_role: row.get(7)?,
        anchor_label: row.get(8)?,
        citation,
        status: row.get(10)?,
        confidence: row.get(11)?,
        rationale: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn map_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicMemoryItemDto> {
    let citation_json: String = row.get(6)?;
    Ok(TopicMemoryItemDto {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        item_type: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        occurred_at: row.get(5)?,
        citation: parse_citation(&citation_json),
        status: row.get(7)?,
        confidence: row.get(8)?,
        rationale: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_relationship(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicMemoryRelationshipDto> {
    let citation_json: String = row.get(5)?;
    Ok(TopicMemoryRelationshipDto {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        source_label: row.get(2)?,
        target_label: row.get(3)?,
        relation_type: row.get(4)?,
        citation: parse_citation(&citation_json),
        status: row.get(6)?,
        confidence: row.get(7)?,
        rationale: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<TopicMemoryProposalDto> {
    Ok(TopicMemoryProposalDto {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        proposal_type: row.get(2)?,
        title: row.get(3)?,
        body_json: row.get(4)?,
        status: row.get(5)?,
        confidence: row.get(6)?,
        rationale: row.get(7)?,
        signature: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn citation_from_source(source: &SourceProposalInput) -> TopicMemoryCitationDto {
    TopicMemoryCitationDto {
        node_id: source.node_id.clone(),
        chunk_id: source.chunk_id.clone(),
        chunk_role: source.chunk_role.clone(),
        anchor_label: source.anchor_label.clone(),
        path: source.path.clone(),
        page: source.page,
        timestamp_ms: source.timestamp_ms,
    }
}

fn empty_citation() -> TopicMemoryCitationDto {
    TopicMemoryCitationDto {
        node_id: String::new(),
        chunk_id: None,
        chunk_role: None,
        anchor_label: None,
        path: None,
        page: None,
        timestamp_ms: None,
    }
}

fn parse_citation(value: &str) -> TopicMemoryCitationDto {
    serde_json::from_str(value).unwrap_or_else(|_| empty_citation())
}

fn to_json<T: Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
}

fn normalize_title(title: &str) -> String {
    title
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn source_signature(topic_id: &str, source: &SourceProposalInput) -> String {
    format!(
        "source:{}:{}:{}",
        topic_id,
        source.node_id.trim(),
        source.chunk_id.as_deref().unwrap_or("")
    )
}

fn item_signature(topic_id: &str, item_type: &str, input: &ItemProposalInput) -> String {
    format!(
        "{}:{}:{}",
        item_type,
        topic_id,
        normalize_title(&format!("{} {}", input.title, input.body))
    )
}

fn relationship_signature(topic_id: &str, input: &RelationshipProposalInput) -> String {
    format!(
        "relationship:{}:{}:{}:{}",
        topic_id,
        normalize_title(&input.source_label),
        normalize_title(&input.relation_type),
        normalize_title(&input.target_label)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(include_str!("../../../migrations/0012_topic_memory.sql"))
            .expect("topic memory schema");
        conn
    }

    #[test]
    fn applies_sources_and_requires_review_for_claims() {
        let conn = setup_conn();
        let batch = TopicProposalBatchInput {
            topics: vec![TopicProposalInput {
                title: "Atlas".into(),
                summary: "Cross-source topic".into(),
                confidence: 0.9,
                rationale: "Repeated term".into(),
                sources: vec![SourceProposalInput {
                    node_id: "node-1".into(),
                    node_title: "Meeting Alpha".into(),
                    node_kind: "voice-note".into(),
                    path: Some("Voice Notes/Meeting Alpha.md".into()),
                    chunk_id: Some("node-1:voice_transcript:0".into()),
                    chunk_role: Some("voice_transcript".into()),
                    anchor_label: Some("Transcript segment 0".into()),
                    page: None,
                    timestamp_ms: None,
                    confidence: 0.88,
                    rationale: "Source mentions Atlas".into(),
                    signature: Some("source:atlas:node-1:0".into()),
                }],
                claims: vec![ItemProposalInput {
                    title: "Budget owner is Mei".into(),
                    body: "Budget owner is Mei.".into(),
                    occurred_at: None,
                    citation: Some(TopicMemoryCitationDto {
                        node_id: "node-1".into(),
                        chunk_id: Some("node-1:voice_transcript:0".into()),
                        chunk_role: Some("voice_transcript".into()),
                        anchor_label: Some("Transcript segment 0".into()),
                        path: Some("Voice Notes/Meeting Alpha.md".into()),
                        page: None,
                        timestamp_ms: None,
                    }),
                    confidence: 0.68,
                    rationale: "Attribution needs review".into(),
                    signature: Some("claim:atlas:budget-owner".into()),
                }],
                events: vec![],
                relationships: vec![],
            }],
        };

        let result = apply_topic_proposals(&conn, &batch).expect("apply proposals");
        assert_eq!(result.topics_created, 1);
        assert_eq!(result.sources_applied, 1);
        assert_eq!(result.proposals_created, 1);

        let topic = list_topics(&conn).expect("topics").remove(0);
        let detail = get_topic_detail(&conn, &topic.id)
            .expect("detail")
            .expect("topic detail");
        assert_eq!(detail.sources.len(), 1);
        assert_eq!(detail.items.len(), 0);
        assert_eq!(detail.proposals.len(), 1);

        let accepted = accept_proposal(&conn, &detail.proposals[0].id)
            .expect("accept")
            .expect("accepted detail");
        assert_eq!(accepted.items.len(), 1);
        assert_eq!(accepted.proposals.len(), 0);
        assert_eq!(
            accepted.items[0].citation.chunk_id.as_deref(),
            Some("node-1:voice_transcript:0")
        );
    }

    #[test]
    fn malformed_proposals_do_not_get_marked_accepted() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO topic_memories (id, title, normalized_title) VALUES ('topic-1', 'Atlas', 'atlas')",
            [],
        )
        .expect("topic");
        conn.execute(
            "
            INSERT INTO topic_memory_proposals (
              id, topic_id, proposal_type, title, body_json, confidence, rationale, signature
            )
            VALUES ('proposal-1', 'topic-1', 'claim', 'Bad claim', '{bad json', 0.7, 'bad body', 'claim:bad')
            ",
            [],
        )
        .expect("proposal");

        assert!(accept_proposal(&conn, "proposal-1")
            .expect("malformed accept")
            .is_none());
        let detail = get_topic_detail(&conn, "topic-1")
            .expect("detail")
            .expect("topic detail");
        assert_eq!(detail.proposals.len(), 1);
        assert_eq!(detail.proposals[0].status, PENDING);
    }

}
