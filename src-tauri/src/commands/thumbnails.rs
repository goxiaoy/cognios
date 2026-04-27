use std::fs;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

use crate::AppState;

const MAX_THUMBNAIL_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNodeThumbnailInput {
    pub node_id: String,
}

#[tauri::command]
pub fn get_node_thumbnail(
    state: State<'_, AppState>,
    input: GetNodeThumbnailInput,
) -> Result<String, String> {
    let conn = state
        .db
        .connect()
        .map_err(|_| "thumbnail unavailable".to_string())?;
    load_thumbnail_data_url(&conn, &input.node_id)
}

pub fn load_thumbnail_data_url(conn: &Connection, node_id: &str) -> Result<String, String> {
    let record =
        load_thumbnail_record(conn, node_id)?.ok_or_else(|| "thumbnail unavailable".to_string())?;
    let mime_type =
        mime_type_for_name(&record.name).ok_or_else(|| "thumbnail unavailable".to_string())?;
    let canonical_mount_root = PathBuf::from(&record.mount_root)
        .canonicalize()
        .map_err(|_| "thumbnail unavailable".to_string())?;
    let candidate_path = canonical_mount_root.join(record.relative_path);
    let metadata =
        fs::symlink_metadata(&candidate_path).map_err(|_| "thumbnail unavailable".to_string())?;

    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_THUMBNAIL_BYTES
    {
        return Err("thumbnail unavailable".into());
    }

    let canonical_candidate = candidate_path
        .canonicalize()
        .map_err(|_| "thumbnail unavailable".to_string())?;

    if !canonical_candidate.starts_with(&canonical_mount_root) {
        return Err("thumbnail unavailable".into());
    }

    let bytes = fs::read(canonical_candidate).map_err(|_| "thumbnail unavailable".to_string())?;
    Ok(format!("data:{mime_type};base64,{}", base64_encode(&bytes)))
}

#[derive(Debug)]
struct ThumbnailRecord {
    name: String,
    mount_root: String,
    relative_path: String,
}

fn load_thumbnail_record(
    conn: &Connection,
    node_id: &str,
) -> Result<Option<ThumbnailRecord>, String> {
    conn.query_row(
        "
        SELECT n.name, m.absolute_path, n.relative_path
        FROM nodes n
        INNER JOIN mounts m ON m.node_id = n.mount_id
        WHERE n.id = ?1 AND n.kind = 'file'
        ",
        [node_id],
        |row| {
            Ok(ThumbnailRecord {
                name: row.get(0)?,
                mount_root: row.get(1)?,
                relative_path: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|_| "thumbnail unavailable".to_string())
}

fn mime_type_for_name(name: &str) -> Option<&'static str> {
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or_default();
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        let combined = ((first as u32) << 16) | ((second as u32) << 8) | third as u32;

        output.push(TABLE[((combined >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((combined >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((combined >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(combined & 0x3f) as usize] as char
        } else {
            '='
        });
    }

    output
}
