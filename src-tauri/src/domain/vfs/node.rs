use serde::Serialize;

use crate::domain::vfs::state::NodeState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKind {
    Folder,
    Url,
    Mount,
    File,
    Note,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Url => "url",
            Self::Mount => "mount",
            Self::File => "file",
            Self::Note => "note",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "url" => Self::Url,
            "mount" => Self::Mount,
            "file" => Self::File,
            "note" => Self::Note,
            // Legacy/dev rows from before mounted subdirectories were
            // folded into Folder. Do not write this value for new rows.
            "directory" => Self::Folder,
            _ => Self::Folder,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NodeRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: NodeKind,
    pub state: NodeState,
    pub created_at: String,
    pub updated_at: String,
    pub size_bytes: i64,
    pub is_voice_note: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerNodeDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub state: String,
    pub created_at: String,
    pub modified_at: String,
    pub size_bytes: i64,
    pub is_voice_note: bool,
    pub children: Vec<ExplorerNodeDto>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExplorerSnapshotDto {
    pub roots: Vec<ExplorerNodeDto>,
}

impl From<NodeRecord> for ExplorerNodeDto {
    fn from(value: NodeRecord) -> Self {
        Self {
            id: value.id,
            parent_id: value.parent_id,
            name: value.name,
            kind: value.kind.as_str().to_string(),
            state: value.state.as_str().to_string(),
            created_at: value.created_at,
            modified_at: value.updated_at,
            size_bytes: value.size_bytes,
            is_voice_note: value.is_voice_note,
            children: Vec::new(),
        }
    }
}
