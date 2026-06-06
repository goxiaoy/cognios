CREATE TABLE IF NOT EXISTS node_status_revisions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO node_status_revisions (id, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS node_statuses (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  label TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  state TEXT NOT NULL,
  importance TEXT NOT NULL,
  message TEXT,
  detail_json TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (node_id, stage_id)
);

CREATE INDEX IF NOT EXISTS idx_node_statuses_node_order
  ON node_statuses(node_id, stage_order);
