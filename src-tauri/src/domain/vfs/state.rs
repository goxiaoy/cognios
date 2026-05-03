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
    /// File whose kind is recognized but has no extractor wired
    /// (e.g. ``.pdf`` / ``.zip`` / arbitrary binary). Distinct
    /// from ``Error`` because there's nothing wrong — the sidecar
    /// just doesn't have a processor for this content. The dot
    /// renders as a hollow neutral outline rather than the red
    /// error tone.
    Unsupported,
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
            Self::Unsupported => "unsupported",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "indexing" => Self::Indexing,
            "indexed" => Self::Indexed,
            "error" => Self::Error,
            "unavailable" => Self::Unavailable,
            "unsupported" => Self::Unsupported,
            _ => Self::Ready,
        }
    }
}
