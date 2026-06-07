use std::collections::{BTreeMap, BTreeSet};

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
pub struct TopicMemoryNodeInput {
    pub node_id: String,
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

pub fn list_topics_for_node(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Vec<TopicMemoryDto>> {
    let mut topic_ids = BTreeSet::new();
    let mut source_stmt = conn.prepare(
        "
        SELECT DISTINCT topic_id
        FROM topic_memory_sources
        WHERE node_id = ?1 AND status = ?2
        ",
    )?;
    for row in source_stmt.query_map(params![node_id, ACTIVE], |row| row.get::<_, String>(0))? {
        topic_ids.insert(row?);
    }

    let mut item_stmt = conn.prepare(
        "
        SELECT topic_id, citation_json
        FROM topic_memory_items
        WHERE status = ?1
        ",
    )?;
    for row in item_stmt.query_map([ACTIVE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (topic_id, citation_json) = row?;
        if parse_citation(&citation_json).node_id == node_id {
            topic_ids.insert(topic_id);
        }
    }

    let mut relationship_stmt = conn.prepare(
        "
        SELECT topic_id, citation_json
        FROM topic_memory_relationships
        WHERE status = ?1
        ",
    )?;
    for row in relationship_stmt.query_map([ACTIVE], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (topic_id, citation_json) = row?;
        if parse_citation(&citation_json).node_id == node_id {
            topic_ids.insert(topic_id);
        }
    }

    let mut topics = Vec::new();
    for topic_id in topic_ids {
        if let Some(topic) = get_topic(conn, &topic_id)? {
            if topic.status != ARCHIVED {
                topics.push(topic);
            }
        }
    }
    topics.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.title.cmp(&right.title))
    });
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
        let existing = find_existing_topic_for_proposal(conn, title, &normalized, topic)?;
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
            let signature = source_signature(source);
            if !proposal_signature_dismissed_any(conn, &signature, source.signature.as_deref())? {
                upsert_source(conn, &topic_id, source, &signature)?;
                result.sources_applied += 1;
            }
        }

        for claim in &topic.claims {
            result.proposals_created += apply_item_or_exception(conn, &topic_id, "claim", claim)?;
        }
        for event in &topic.events {
            result.proposals_created += apply_item_or_exception(conn, &topic_id, "event", event)?;
        }
        for relationship in &topic.relationships {
            result.proposals_created +=
                apply_relationship_or_exception(conn, &topic_id, relationship)?;
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
            .map(|input| {
                let signature = source_signature(&input);
                upsert_source(conn, &topic_id, &input, &signature)
            })
            .ok(),
        "claim" | "event" => serde_json::from_value::<ItemProposalInput>(body)
            .map(|input| {
                let signature = item_signature(&topic_id, &proposal.proposal_type, &input);
                insert_item(conn, &topic_id, &proposal.proposal_type, &input, &signature)
            })
            .ok(),
        "relationship" => serde_json::from_value::<RelationshipProposalInput>(body)
            .map(|input| {
                let signature = relationship_signature(&topic_id, &input);
                insert_relationship(conn, &topic_id, &input, &signature)
            })
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

fn find_existing_topic_for_proposal(
    conn: &Connection,
    title: &str,
    normalized_title: &str,
    proposal: &TopicProposalInput,
) -> rusqlite::Result<Option<TopicMemoryDto>> {
    if let Some(topic) = get_topic_by_normalized_title(conn, normalized_title)? {
        return Ok(Some(topic));
    }
    let mut overlaps = BTreeMap::<String, u32>::new();
    for source in &proposal.sources {
        let node_id = source.node_id.trim();
        if node_id.is_empty() {
            continue;
        }
        let chunk_id = source.chunk_id.as_deref().unwrap_or("").trim();
        let mut stmt = conn.prepare(
            "
            SELECT DISTINCT topic_id
            FROM topic_memory_sources
            WHERE node_id = ?1 AND COALESCE(chunk_id, '') = ?2 AND status = ?3
            ",
        )?;
        for row in stmt.query_map(params![node_id, chunk_id, ACTIVE], |row| {
            row.get::<_, String>(0)
        })? {
            *overlaps.entry(row?).or_insert(0) += 1;
        }
    }
    let mut best: Option<(TopicMemoryDto, u32)> = None;
    for (topic_id, overlap) in overlaps {
        let Some(topic) = get_topic(conn, &topic_id)? else {
            continue;
        };
        if topic.status == ARCHIVED {
            continue;
        }
        let enough_shared_evidence = overlap >= 2;
        let related_title = overlap >= 1 && titles_are_related(title, &topic.title);
        if enough_shared_evidence || related_title {
            match &best {
                Some((current, current_overlap))
                    if *current_overlap > overlap
                        || (*current_overlap == overlap
                            && current.updated_at >= topic.updated_at) => {}
                _ => best = Some((topic, overlap)),
            }
        }
    }
    Ok(best.map(|(topic, _)| topic))
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
    let existing_ids = source_ids_by_natural_key(conn, topic_id, source)?;
    if let Some((keep_id, duplicate_ids)) = existing_ids.split_first() {
        for duplicate_id in duplicate_ids {
            conn.execute(
                "DELETE FROM topic_memory_sources WHERE id = ?1",
                [duplicate_id],
            )?;
        }
        conn.execute(
            "
            UPDATE topic_memory_sources
            SET node_title = ?2,
                node_kind = ?3,
                path = ?4,
                chunk_id = ?5,
                chunk_role = ?6,
                anchor_label = ?7,
                citation_json = ?8,
                status = ?9,
                confidence = MAX(confidence, ?10),
                rationale = ?11,
                signature = ?12,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            params![
                keep_id,
                source.node_title.trim(),
                source.node_kind.trim(),
                source.path,
                source.chunk_id,
                source.chunk_role,
                source.anchor_label,
                citation_json,
                ACTIVE,
                source.confidence,
                source.rationale.trim(),
                signature
            ],
        )?;
        return Ok(());
    }
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

fn apply_item_or_exception(
    conn: &Connection,
    topic_id: &str,
    item_type: &str,
    input: &ItemProposalInput,
) -> rusqlite::Result<u32> {
    let signature = item_signature(topic_id, item_type, input);
    if proposal_signature_dismissed_any(conn, &signature, input.signature.as_deref())? {
        return Ok(0);
    }
    if input.citation.as_ref().is_some_and(citation_has_source) {
        insert_item(conn, topic_id, item_type, input, &signature)?;
        return Ok(0);
    }
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

fn apply_relationship_or_exception(
    conn: &Connection,
    topic_id: &str,
    input: &RelationshipProposalInput,
) -> rusqlite::Result<u32> {
    let signature = relationship_signature(topic_id, input);
    if proposal_signature_dismissed_any(conn, &signature, input.signature.as_deref())? {
        return Ok(0);
    }
    if input.citation.as_ref().is_some_and(citation_has_source) {
        insert_relationship(conn, topic_id, input, &signature)?;
        return Ok(0);
    }
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
    let existing_ids = item_ids_by_natural_key(conn, topic_id, item_type, input)?;
    if let Some((keep_id, duplicate_ids)) = existing_ids.split_first() {
        for duplicate_id in duplicate_ids {
            conn.execute(
                "DELETE FROM topic_memory_items WHERE id = ?1",
                [duplicate_id],
            )?;
        }
        conn.execute(
            "
            UPDATE topic_memory_items
            SET title = ?2,
                body = ?3,
                occurred_at = ?4,
                citation_json = ?5,
                status = ?6,
                confidence = MAX(confidence, ?7),
                rationale = ?8,
                signature = ?9,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            params![
                keep_id,
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
        return Ok(());
    }
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
    let existing_ids = relationship_ids_by_natural_key(conn, topic_id, input)?;
    if let Some((keep_id, duplicate_ids)) = existing_ids.split_first() {
        for duplicate_id in duplicate_ids {
            conn.execute(
                "DELETE FROM topic_memory_relationships WHERE id = ?1",
                [duplicate_id],
            )?;
        }
        conn.execute(
            "
            UPDATE topic_memory_relationships
            SET source_label = ?2,
                target_label = ?3,
                relation_type = ?4,
                citation_json = ?5,
                status = ?6,
                confidence = MAX(confidence, ?7),
                rationale = ?8,
                signature = ?9,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
            params![
                keep_id,
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
        return Ok(());
    }
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

fn proposal_signature_dismissed_any(
    conn: &Connection,
    stable_signature: &str,
    original_signature: Option<&str>,
) -> rusqlite::Result<bool> {
    if proposal_signature_dismissed(conn, stable_signature)? {
        return Ok(true);
    }
    let Some(original_signature) = original_signature else {
        return Ok(false);
    };
    if original_signature == stable_signature {
        return Ok(false);
    }
    proposal_signature_dismissed(conn, original_signature)
}

fn source_ids_by_natural_key(
    conn: &Connection,
    topic_id: &str,
    source: &SourceProposalInput,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "
        SELECT id
        FROM topic_memory_sources
        WHERE topic_id = ?1
          AND node_id = ?2
          AND COALESCE(chunk_id, '') = ?3
          AND status = ?4
        ORDER BY updated_at DESC, id ASC
        ",
    )?;
    let ids = stmt
        .query_map(
            params![
                topic_id,
                source.node_id.trim(),
                source.chunk_id.as_deref().unwrap_or("").trim(),
                ACTIVE
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect();
    ids
}

fn item_ids_by_natural_key(
    conn: &Connection,
    topic_id: &str,
    item_type: &str,
    input: &ItemProposalInput,
) -> rusqlite::Result<Vec<String>> {
    let natural_key = item_natural_key(input);
    let mut stmt = conn.prepare(
        "
        SELECT id, title, body
        FROM topic_memory_items
        WHERE topic_id = ?1 AND item_type = ?2 AND status = ?3
        ORDER BY updated_at DESC, id ASC
        ",
    )?;
    let mut ids = Vec::new();
    for row in stmt.query_map(params![topic_id, item_type, ACTIVE], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })? {
        let (id, title, body) = row?;
        if normalize_title(&format!("{} {}", title, body)) == natural_key {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn relationship_ids_by_natural_key(
    conn: &Connection,
    topic_id: &str,
    input: &RelationshipProposalInput,
) -> rusqlite::Result<Vec<String>> {
    let natural_key = relationship_natural_key(input);
    let mut stmt = conn.prepare(
        "
        SELECT id, source_label, relation_type, target_label
        FROM topic_memory_relationships
        WHERE topic_id = ?1 AND status = ?2
        ORDER BY updated_at DESC, id ASC
        ",
    )?;
    let mut ids = Vec::new();
    for row in stmt.query_map(params![topic_id, ACTIVE], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })? {
        let (id, source_label, relation_type, target_label) = row?;
        if normalize_title(&format!(
            "{} {} {}",
            source_label, relation_type, target_label
        )) == natural_key
        {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn titles_are_related(left: &str, right: &str) -> bool {
    let left = normalize_title(left);
    let right = normalize_title(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right || left.contains(&right) || right.contains(&left) {
        return true;
    }
    let left_tokens: BTreeSet<_> = left
        .split_whitespace()
        .filter(|token| token.len() > 2)
        .collect();
    let right_tokens: BTreeSet<_> = right
        .split_whitespace()
        .filter(|token| token.len() > 2)
        .collect();
    !left_tokens.is_empty() && !right_tokens.is_empty() && !left_tokens.is_disjoint(&right_tokens)
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

fn citation_has_source(citation: &TopicMemoryCitationDto) -> bool {
    !citation.node_id.trim().is_empty()
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

fn source_signature(source: &SourceProposalInput) -> String {
    format!(
        "source:{}:{}",
        source.node_id.trim(),
        source.chunk_id.as_deref().unwrap_or("")
    )
}

fn item_natural_key(input: &ItemProposalInput) -> String {
    normalize_title(&format!("{} {}", input.title, input.body))
}

fn item_signature(topic_id: &str, item_type: &str, input: &ItemProposalInput) -> String {
    format!("{}:{}:{}", item_type, topic_id, item_natural_key(input))
}

fn relationship_natural_key(input: &RelationshipProposalInput) -> String {
    normalize_title(&format!(
        "{} {} {}",
        input.source_label, input.relation_type, input.target_label
    ))
}

fn relationship_signature(topic_id: &str, input: &RelationshipProposalInput) -> String {
    format!(
        "relationship:{}:{}",
        topic_id,
        relationship_natural_key(input)
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
    fn applies_cited_claims_directly() {
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
                    rationale: "Cited attribution".into(),
                    signature: Some("claim:atlas:budget-owner".into()),
                }],
                events: vec![],
                relationships: vec![],
            }],
        };

        let result = apply_topic_proposals(&conn, &batch).expect("apply proposals");
        assert_eq!(result.topics_created, 1);
        assert_eq!(result.sources_applied, 1);
        assert_eq!(result.proposals_created, 0);

        let topic = list_topics(&conn).expect("topics").remove(0);
        let detail = get_topic_detail(&conn, &topic.id)
            .expect("detail")
            .expect("topic detail");
        assert_eq!(detail.sources.len(), 1);
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.proposals.len(), 0);
        assert_eq!(
            detail.items[0].citation.chunk_id.as_deref(),
            Some("node-1:voice_transcript:0")
        );

        let linked_topics = list_topics_for_node(&conn, "node-1").expect("topics linked to node");
        assert_eq!(linked_topics.len(), 1);
        assert_eq!(linked_topics[0].id, topic.id);
    }

    #[test]
    fn uncited_claims_become_exception_proposals() {
        let conn = setup_conn();
        let batch = TopicProposalBatchInput {
            topics: vec![TopicProposalInput {
                title: "Atlas".into(),
                summary: "Cross-source topic".into(),
                confidence: 0.9,
                rationale: "Repeated term".into(),
                sources: vec![],
                claims: vec![ItemProposalInput {
                    title: "Budget owner is Mei".into(),
                    body: "Budget owner is Mei.".into(),
                    occurred_at: None,
                    citation: None,
                    confidence: 0.68,
                    rationale: "No citation attached".into(),
                    signature: Some("claim:atlas:budget-owner".into()),
                }],
                events: vec![],
                relationships: vec![],
            }],
        };

        let result = apply_topic_proposals(&conn, &batch).expect("apply proposals");
        assert_eq!(result.proposals_created, 1);

        let topic = list_topics(&conn).expect("topics").remove(0);
        let detail = get_topic_detail(&conn, &topic.id)
            .expect("detail")
            .expect("topic detail");
        assert_eq!(detail.items.len(), 0);
        assert_eq!(detail.proposals.len(), 1);
    }

    #[test]
    fn refresh_reuses_existing_topic_when_llm_renames_same_evidence() {
        let conn = setup_conn();
        let first = TopicProposalBatchInput {
            topics: vec![TopicProposalInput {
                title: "Atlas".into(),
                summary: "Atlas launch planning.".into(),
                confidence: 0.82,
                rationale: "Supported by cited evidence.".into(),
                sources: vec![SourceProposalInput {
                    node_id: "meeting-1".into(),
                    node_title: "Meeting Alpha".into(),
                    node_kind: "voice-note".into(),
                    path: Some("Voice Notes/Meeting Alpha.md".into()),
                    chunk_id: Some("meeting-1:0".into()),
                    chunk_role: Some("voice_transcript".into()),
                    anchor_label: Some("Transcript segment 0".into()),
                    page: None,
                    timestamp_ms: None,
                    confidence: 0.84,
                    rationale: "LLM selected this evidence.".into(),
                    signature: Some("source:atlas:meeting-1:meeting-1:0".into()),
                }],
                claims: vec![ItemProposalInput {
                    title: "Budget owner is Mei".into(),
                    body: "Budget owner is Mei.".into(),
                    occurred_at: None,
                    citation: Some(TopicMemoryCitationDto {
                        node_id: "meeting-1".into(),
                        chunk_id: Some("meeting-1:0".into()),
                        chunk_role: Some("voice_transcript".into()),
                        anchor_label: Some("Transcript segment 0".into()),
                        path: Some("Voice Notes/Meeting Alpha.md".into()),
                        page: None,
                        timestamp_ms: None,
                    }),
                    confidence: 0.72,
                    rationale: "Explicitly stated.".into(),
                    signature: Some("claim:atlas:budget-owner:E1".into()),
                }],
                events: vec![],
                relationships: vec![],
            }],
        };
        let second = TopicProposalBatchInput {
            topics: vec![TopicProposalInput {
                title: "Atlas Launch".into(),
                summary: "Atlas launch planning spans meeting evidence.".into(),
                confidence: 0.88,
                rationale: "Same evidence, renamed by the LLM.".into(),
                sources: vec![SourceProposalInput {
                    node_id: "meeting-1".into(),
                    node_title: "Meeting Alpha".into(),
                    node_kind: "voice-note".into(),
                    path: Some("Voice Notes/Meeting Alpha.md".into()),
                    chunk_id: Some("meeting-1:0".into()),
                    chunk_role: Some("voice_transcript".into()),
                    anchor_label: Some("Transcript segment 0".into()),
                    page: None,
                    timestamp_ms: None,
                    confidence: 0.9,
                    rationale: "LLM selected this evidence again.".into(),
                    signature: Some("source:atlas-launch:meeting-1:meeting-1:0".into()),
                }],
                claims: vec![ItemProposalInput {
                    title: "Budget owner is Mei".into(),
                    body: "Budget owner is Mei.".into(),
                    occurred_at: None,
                    citation: Some(TopicMemoryCitationDto {
                        node_id: "meeting-1".into(),
                        chunk_id: Some("meeting-1:0".into()),
                        chunk_role: Some("voice_transcript".into()),
                        anchor_label: Some("Transcript segment 0".into()),
                        path: Some("Voice Notes/Meeting Alpha.md".into()),
                        page: None,
                        timestamp_ms: None,
                    }),
                    confidence: 0.76,
                    rationale: "Same cited fact.".into(),
                    signature: Some("claim:atlas-launch:budget-owner:E1".into()),
                }],
                events: vec![],
                relationships: vec![],
            }],
        };

        let first_result = apply_topic_proposals(&conn, &first).expect("first refresh");
        assert_eq!(first_result.topics_created, 1);

        let second_result = apply_topic_proposals(&conn, &second).expect("second refresh");
        assert_eq!(second_result.topics_created, 0);
        assert_eq!(second_result.topics_updated, 1);

        let topics = list_topics(&conn).expect("topics");
        assert_eq!(topics.len(), 1);
        let detail = get_topic_detail(&conn, &topics[0].id)
            .expect("detail")
            .expect("topic detail");
        assert_eq!(detail.topic.title, "Atlas");
        assert_eq!(detail.sources.len(), 1);
        assert_eq!(detail.items.len(), 1);
        assert_eq!(detail.sources[0].confidence, 0.9);
        assert_eq!(detail.items[0].confidence, 0.76);
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
