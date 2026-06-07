CREATE TABLE IF NOT EXISTS statistics (
  metric_key TEXT NOT NULL,
  bucket_date TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (metric_key, bucket_date)
);

CREATE INDEX IF NOT EXISTS idx_statistics_metric_bucket
  ON statistics(metric_key, bucket_date);
