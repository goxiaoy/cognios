use std::path::Path;

use rusqlite::{params, Connection};

pub fn save_note_content(
    conn: &Connection,
    note_id: &str,
    body: &str,
    notes_dir: &Path,
) -> Result<(), String> {
    let note_path = notes_dir.join(format!("{note_id}.md"));
    std::fs::write(&note_path, body.as_bytes()).map_err(|error| error.to_string())?;

    let size_bytes = body.len() as i64;
    conn.execute(
        "UPDATE nodes SET size_bytes = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![note_id, size_bytes],
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}
