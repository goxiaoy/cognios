use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionDto {
    pub id: String,
    pub title: String,
    pub bound_note_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionMemoryDto {
    pub available: bool,
    pub status: String,
    pub revision: i64,
    pub last_successful_revision: i64,
    pub last_included_message_ordinal: i64,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub body: String,
    pub ordinal: i64,
    pub metadata_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSourceClusterDto {
    pub id: String,
    pub session_id: String,
    pub turn_message_id: Option<String>,
    pub title: String,
    pub source_kind: String,
    pub status: String,
    pub summary: String,
    pub score: f64,
    pub sources_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionDetailDto {
    pub session: ChatSessionDto,
    pub messages: Vec<ChatMessageDto>,
    pub clusters: Vec<ChatSourceClusterDto>,
    pub memory: Option<ChatSessionMemoryDto>,
}
