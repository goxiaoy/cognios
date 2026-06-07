CREATE TABLE IF NOT EXISTS urls (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,
  preview_text TEXT,
  canonical_url TEXT,
  html_cache_path TEXT,
  last_error TEXT
);
