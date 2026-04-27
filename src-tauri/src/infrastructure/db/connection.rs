use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::infrastructure::db::migrations::run_migrations;

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn connect(&self) -> rusqlite::Result<Connection> {
        open_database(&self.path)
    }
}

pub fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    configure_connection(&conn)?;
    run_migrations(&conn)?;
    Ok(conn)
}

pub fn open_in_memory_database() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure_connection(&conn)?;
    run_migrations(&conn)?;
    Ok(conn)
}

fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        ",
    )?;

    Ok(())
}
