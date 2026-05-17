use std::collections::BTreeMap;

use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceNoteDto {
    pub note_id: String,
    pub name: String,
    pub status: String,
    pub capture_status: String,
    pub transcription_status: String,
    pub summary_status: String,
    pub source_audio_present: bool,
    pub source_audio_path: Option<String>,
    pub source_audio_deleted_at: Option<String>,
    pub transcript_path: Option<String>,
    pub transcript_updated_at: Option<String>,
    pub speaker_labels: BTreeMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
}

impl VoiceNoteDto {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let source_audio_path: Option<String> = row.get("source_audio_path")?;
        let speaker_labels_json: String = row.get("speaker_labels_json")?;
        let speaker_labels = serde_json::from_str::<BTreeMap<String, String>>(&speaker_labels_json)
            .unwrap_or_default();

        Ok(Self {
            note_id: row.get("note_id")?,
            name: row.get("name")?,
            status: row.get("status")?,
            capture_status: row.get("capture_status")?,
            transcription_status: row.get("transcription_status")?,
            summary_status: row.get("summary_status")?,
            source_audio_present: source_audio_path.is_some(),
            source_audio_path,
            source_audio_deleted_at: row.get("source_audio_deleted_at")?,
            transcript_path: row.get("transcript_path")?,
            transcript_updated_at: row.get("transcript_updated_at")?,
            speaker_labels,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}
