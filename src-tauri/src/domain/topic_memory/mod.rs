use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryDto {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub confidence: f64,
    pub rationale: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryCitationDto {
    pub node_id: String,
    pub chunk_id: Option<String>,
    pub chunk_role: Option<String>,
    pub anchor_label: Option<String>,
    pub path: Option<String>,
    pub page: Option<u32>,
    pub timestamp_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemorySourceDto {
    pub id: String,
    pub topic_id: String,
    pub node_id: String,
    pub node_title: String,
    pub node_kind: String,
    pub path: Option<String>,
    pub chunk_id: Option<String>,
    pub chunk_role: Option<String>,
    pub anchor_label: Option<String>,
    pub citation: TopicMemoryCitationDto,
    pub status: String,
    pub confidence: f64,
    pub rationale: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryItemDto {
    pub id: String,
    pub topic_id: String,
    pub item_type: String,
    pub title: String,
    pub body: String,
    pub occurred_at: Option<String>,
    pub citation: TopicMemoryCitationDto,
    pub status: String,
    pub confidence: f64,
    pub rationale: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryRelationshipDto {
    pub id: String,
    pub topic_id: String,
    pub source_label: String,
    pub target_label: String,
    pub relation_type: String,
    pub citation: TopicMemoryCitationDto,
    pub status: String,
    pub confidence: f64,
    pub rationale: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryProposalDto {
    pub id: String,
    pub topic_id: Option<String>,
    pub proposal_type: String,
    pub title: String,
    pub body_json: String,
    pub status: String,
    pub confidence: f64,
    pub rationale: String,
    pub signature: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryDetailDto {
    pub topic: TopicMemoryDto,
    pub sources: Vec<TopicMemorySourceDto>,
    pub items: Vec<TopicMemoryItemDto>,
    pub relationships: Vec<TopicMemoryRelationshipDto>,
    pub proposals: Vec<TopicMemoryProposalDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicMemoryRefreshResultDto {
    pub topics_created: u32,
    pub topics_updated: u32,
    pub sources_applied: u32,
    pub proposals_created: u32,
}
