CREATE TABLE IF NOT EXISTS voice_notes (
  note_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_audio'
    CHECK (status IN ('pending_audio', 'recording', 'transcribing', 'speaker_processing', 'indexing', 'completed', 'failed')),
  capture_status TEXT NOT NULL DEFAULT 'unsupported'
    CHECK (capture_status IN ('unsupported', 'pending', 'recording', 'completed', 'failed')),
  transcription_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcription_status IN ('pending', 'transcribing', 'completed', 'failed', 'unavailable')),
  summary_status TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (summary_status IN ('unavailable', 'pending', 'ready', 'failed')),
  source_audio_path TEXT,
  source_audio_deleted_at TEXT,
  transcript_updated_at TEXT,
  speaker_labels_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_notes_status ON voice_notes(status);
