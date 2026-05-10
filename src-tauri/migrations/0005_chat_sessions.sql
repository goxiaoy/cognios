CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  bound_note_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chat_source_clusters (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  turn_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace', 'web', 'mixed')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'accepted', 'excluded', 'suggested')),
  summary TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_ordinal
  ON chat_messages(session_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_chat_clusters_session_status
  ON chat_source_clusters(session_id, status);
