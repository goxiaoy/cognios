ALTER TABLE nodes ADD COLUMN mount_id TEXT;
ALTER TABLE nodes ADD COLUMN relative_path TEXT;

CREATE TABLE IF NOT EXISTS mounts (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  absolute_path TEXT NOT NULL,
  ignore_config TEXT NOT NULL,
  is_available INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_nodes_mount_id ON nodes(mount_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_mount_relative_path
ON nodes(mount_id, relative_path)
WHERE mount_id IS NOT NULL AND relative_path IS NOT NULL;
