use rusqlite::{params, Connection};

pub const INDEXED_NODES_METRIC: &str = "index.nodes";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyStatistic {
    pub date: String,
    pub count: u64,
}

pub fn increment_daily_stat(
    conn: &Connection,
    metric_key: &str,
    amount: u64,
) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO statistics (metric_key, bucket_date, value, updated_at)
        VALUES (?1, date('now', 'localtime'), ?2, CURRENT_TIMESTAMP)
        ON CONFLICT(metric_key, bucket_date) DO UPDATE SET
          value = value + excluded.value,
          updated_at = CURRENT_TIMESTAMP
        ",
        params![metric_key, amount as i64],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

pub fn recent_daily_stats(
    conn: &Connection,
    metric_key: &str,
    days: u32,
) -> Result<Vec<DailyStatistic>, String> {
    let days = days.clamp(1, 366);
    let mut stmt = conn
        .prepare(
            "
            WITH RECURSIVE days(offset, bucket_date) AS (
              SELECT ?2 - 1, date('now', 'localtime', printf('-%d days', ?2 - 1))
              UNION ALL
              SELECT offset - 1, date(bucket_date, '+1 day')
              FROM days
              WHERE offset > 0
            )
            SELECT
              days.bucket_date,
              COALESCE(statistics.value, 0)
            FROM days
            LEFT JOIN statistics
              ON statistics.metric_key = ?1
             AND statistics.bucket_date = days.bucket_date
            ORDER BY days.bucket_date ASC
            ",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![metric_key, days as i64], |row| {
            Ok(DailyStatistic {
                date: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::db::connection::{open_database, Database};

    use super::*;

    fn setup_db() -> Database {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cognios.db");
        let conn = open_database(&path).unwrap();
        drop(conn);
        std::mem::forget(dir);
        Database::new(path)
    }

    #[test]
    fn increment_daily_stat_accumulates_today() {
        let db = setup_db();
        let conn = db.connect().unwrap();

        increment_daily_stat(&conn, INDEXED_NODES_METRIC, 1).unwrap();
        increment_daily_stat(&conn, INDEXED_NODES_METRIC, 2).unwrap();

        let rows = recent_daily_stats(&conn, INDEXED_NODES_METRIC, 1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 3);
    }

    #[test]
    fn recent_daily_stats_fills_empty_days() {
        let db = setup_db();
        let conn = db.connect().unwrap();

        let rows = recent_daily_stats(&conn, INDEXED_NODES_METRIC, 7).unwrap();
        assert_eq!(rows.len(), 7);
        assert!(rows.iter().all(|row| row.count == 0));
    }
}
