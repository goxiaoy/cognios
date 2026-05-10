CREATE TABLE IF NOT EXISTS chat_session_memories (
  session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'dirty'
    CHECK (status IN ('dirty', 'running', 'ready', 'deleted')),
  file_key TEXT,
  memory_revision INTEGER NOT NULL DEFAULT 0,
  last_successful_revision INTEGER NOT NULL DEFAULT 0,
  body_checksum TEXT,
  body_byte_len INTEGER,
  body_written_at TEXT,
  last_included_message_ordinal INTEGER NOT NULL DEFAULT -1,
  dirty_round_count INTEGER NOT NULL DEFAULT 0,
  dirty_token_count INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  model_id TEXT,
  job_id TEXT,
  last_error TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_session_memories_status
  ON chat_session_memories(status, updated_at);
