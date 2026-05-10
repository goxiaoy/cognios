use rusqlite::Connection;

const INITIAL_SCHEMA: &str = include_str!("../../../migrations/0001_initial.sql");
const MOUNT_SCHEMA: &str = include_str!("../../../migrations/0002_mounts.sql");
const URL_SCHEMA: &str = include_str!("../../../migrations/0003_urls.sql");
const NODE_METADATA_SCHEMA: &str = include_str!("../../../migrations/0004_node_metadata.sql");
const CHAT_SESSIONS_SCHEMA: &str = include_str!("../../../migrations/0005_chat_sessions.sql");
const SESSION_MEMORY_SCHEMA: &str = include_str!("../../../migrations/0006_session_memory.sql");

pub fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let current_version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if current_version < 1 {
        conn.execute_batch(INITIAL_SCHEMA)?;
        conn.pragma_update(None, "user_version", 1)?;
    }

    if current_version < 2 {
        conn.execute_batch(MOUNT_SCHEMA)?;
        conn.pragma_update(None, "user_version", 2)?;
    }

    if current_version < 3 {
        conn.execute_batch(URL_SCHEMA)?;
        conn.pragma_update(None, "user_version", 3)?;
    }

    if current_version < 4 {
        conn.execute_batch(NODE_METADATA_SCHEMA)?;
        conn.pragma_update(None, "user_version", 4)?;
    }

    if current_version < 5 {
        conn.execute_batch(CHAT_SESSIONS_SCHEMA)?;
        conn.pragma_update(None, "user_version", 5)?;
    }

    if current_version < 6 {
        conn.execute_batch(SESSION_MEMORY_SCHEMA)?;
        conn.pragma_update(None, "user_version", 6)?;
    }

    Ok(())
}
