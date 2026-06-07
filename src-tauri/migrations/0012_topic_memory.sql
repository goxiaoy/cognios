CREATE TABLE IF NOT EXISTS topic_memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS topic_memory_sources (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topic_memories(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_title TEXT NOT NULL,
  node_kind TEXT NOT NULL DEFAULT '',
  path TEXT,
  chunk_id TEXT,
  chunk_role TEXT,
  anchor_label TEXT,
  citation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dismissed')),
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(topic_id, signature)
);

CREATE TABLE IF NOT EXISTS topic_memory_items (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topic_memories(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('claim', 'event', 'decision')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  occurred_at TEXT,
  citation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_review', 'dismissed')),
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(topic_id, item_type, signature)
);

CREATE TABLE IF NOT EXISTS topic_memory_relationships (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topic_memories(id) ON DELETE CASCADE,
  source_label TEXT NOT NULL,
  target_label TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  citation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending_review', 'dismissed')),
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(topic_id, signature)
);

CREATE TABLE IF NOT EXISTS topic_memory_proposals (
  id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES topic_memories(id) ON DELETE CASCADE,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'dismissed')),
  confidence REAL NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_topic_memories_status_updated
  ON topic_memories(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_topic_sources_topic_status
  ON topic_memory_sources(topic_id, status);

CREATE INDEX IF NOT EXISTS idx_topic_items_topic_status
  ON topic_memory_items(topic_id, status);

CREATE INDEX IF NOT EXISTS idx_topic_relationships_topic_status
  ON topic_memory_relationships(topic_id, status);

CREATE INDEX IF NOT EXISTS idx_topic_proposals_status_updated
  ON topic_memory_proposals(status, updated_at);
