use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Ready,
    Pending,
    Indexing,
    Indexed,
    Error,
    Unavailable,
}

impl NodeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Pending => "pending",
            Self::Indexing => "indexing",
            Self::Indexed => "indexed",
            Self::Error => "error",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "indexing" => Self::Indexing,
            "indexed" => Self::Indexed,
            "error" => Self::Error,
            "unavailable" => Self::Unavailable,
            _ => Self::Ready,
        }
    }
}
