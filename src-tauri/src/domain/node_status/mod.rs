use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageImportance {
    Required,
    Optional,
}

impl StageImportance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Optional => "optional",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "optional" => Self::Optional,
            _ => Self::Required,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Blocked,
}

impl StageState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Blocked => "blocked",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "blocked" => Self::Blocked,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatusOverall {
    Idle,
    Queued,
    Running,
    Ready,
    Partial,
    Failed,
    Unsupported,
}

impl NodeStatusOverall {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Ready => "ready",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStageErrorDto {
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStageStatusDto {
    pub id: String,
    pub label: String,
    pub state: String,
    pub importance: String,
    pub message: Option<String>,
    pub detail: Option<serde_json::Value>,
    pub error: Option<NodeStageErrorDto>,
    pub attempt: u32,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatusViewDto {
    pub node_id: String,
    pub overall: String,
    pub primary_stage_id: Option<String>,
    pub stages: Vec<NodeStageStatusDto>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatusSnapshotDto {
    pub revision: u64,
    pub nodes: std::collections::BTreeMap<String, NodeStatusViewDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatusChangedEventDto {
    pub revision: u64,
    pub node_id: String,
    pub status: NodeStatusViewDto,
}

#[derive(Clone, Copy, Debug)]
pub struct StageDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub order: i64,
    pub importance: StageImportance,
}

#[derive(Clone, Debug)]
pub struct StageUpdate {
    pub state: StageState,
    pub message: Option<String>,
    pub detail: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub retryable: bool,
    pub attempt: Option<u32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl StageUpdate {
    pub fn pending(message: impl Into<String>) -> Self {
        Self {
            state: StageState::Pending,
            message: Some(message.into()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: None,
        }
    }

    pub fn running(message: impl Into<String>) -> Self {
        Self {
            state: StageState::Running,
            message: Some(message.into()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: Some("CURRENT_TIMESTAMP".to_string()),
            finished_at: None,
        }
    }

    pub fn succeeded(message: impl Into<String>) -> Self {
        Self {
            state: StageState::Succeeded,
            message: Some(message.into()),
            detail: None,
            error_message: None,
            retryable: false,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        }
    }

    pub fn failed(message: impl Into<String>, retryable: bool) -> Self {
        let message = message.into();
        Self {
            state: StageState::Failed,
            message: Some(message.clone()),
            detail: None,
            error_message: Some(message),
            retryable,
            attempt: None,
            started_at: None,
            finished_at: Some("CURRENT_TIMESTAMP".to_string()),
        }
    }
}
