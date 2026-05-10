use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::infrastructure::db::chat_repository::{bind_note, BindChatNoteInput};
use crate::services::mounts::watcher::VfsChangeEvent;
use crate::services::notes::create_note::{create_note, CreateNoteInput};
use crate::services::notes::save_note_content::save_note_content;

pub fn update_live_note(
    conn: &mut Connection,
    session_id: &str,
    answer: &str,
    citations: &[serde_json::Value],
    notes_dir: &Path,
    emitter: &dyn Fn(VfsChangeEvent),
) -> Result<String, String> {
    let note_id = match bound_note_id(conn, session_id)? {
        Some(note_id) => note_id,
        None => {
            let created = create_note(
                conn,
                &CreateNoteInput { parent_id: None },
                notes_dir,
                emitter,
            )?;
            bind_note(
                conn,
                &BindChatNoteInput {
                    session_id: session_id.to_string(),
                    note_id: created.node_id.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
            created.node_id
        }
    };

    let body = render_live_note(answer, citations);
    save_note_content(conn, &note_id, &body, notes_dir, emitter)?;
    Ok(note_id)
}

pub fn render_live_note(answer: &str, citations: &[serde_json::Value]) -> String {
    let mut body = String::from("# Chat Note\n\n");
    body.push_str(answer.trim());
    body.push('\n');
    if !citations.is_empty() {
        body.push_str("\n## Sources\n\n");
        for citation in citations {
            let title = citation
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Source");
            let source_kind = citation
                .get("sourceKind")
                .or_else(|| citation.get("source_kind"))
                .and_then(|value| value.as_str())
                .unwrap_or("source");
            let target = citation
                .get("citation")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            body.push_str(&format!("- [{source_kind}] {title}: {target}\n"));
        }
    }
    body
}

fn bound_note_id(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT bound_note_id FROM chat_sessions WHERE id = ?1",
        [session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "chat session does not exist".to_string())
}
