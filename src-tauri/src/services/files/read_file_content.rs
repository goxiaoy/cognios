use std::fs;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};

// Cap for read-only text preview. Sized for CodeMirror syntax-highlight performance,
// not for raw IPC transfer — well below the 5 MB image thumbnail cap because
// CodeMirror's layout pass scales noticeably with content length on text.
//
// Frontend extension allowlist lives in src/features/explorer/utils/presentation.ts
// (MARKDOWN_EXTENSIONS). The two lists must change together.
pub const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;
const ALLOWED_EXTENSIONS: &[&str] = &["md", "mdx"];

pub fn read_file_content(conn: &Connection, node_id: &str) -> Result<String, String> {
    let record = load_file_record(conn, node_id)
        .map_err(|_| "file unavailable".to_string())?
        .ok_or_else(|| "file unavailable".to_string())?;

    if !is_previewable_extension(&record.relative_path) {
        return Err("not previewable".into());
    }

    let canonical_root = PathBuf::from(&record.mount_root)
        .canonicalize()
        .map_err(|_| "file unavailable".to_string())?;
    let candidate = canonical_root.join(&record.relative_path);

    let meta = fs::symlink_metadata(&candidate).map_err(|_| "file unavailable".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("file unavailable".into());
    }
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err("file too large".into());
    }

    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| "file unavailable".to_string())?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("file unavailable".into());
    }

    fs::read_to_string(canonical_candidate).map_err(|_| "file unavailable".to_string())
}

struct FileRecord {
    mount_root: String,
    relative_path: String,
}

fn load_file_record(
    conn: &Connection,
    node_id: &str,
) -> Result<Option<FileRecord>, rusqlite::Error> {
    conn.query_row(
        "
        SELECT m.absolute_path, n.relative_path
        FROM nodes n
        INNER JOIN mounts m ON m.node_id = n.mount_id
        WHERE n.id = ?1 AND n.kind = 'file'
        ",
        [node_id],
        |row| {
            Ok(FileRecord {
                mount_root: row.get(0)?,
                relative_path: row.get(1)?,
            })
        },
    )
    .optional()
}

fn is_previewable_extension(relative_path: &str) -> bool {
    let extension = match relative_path.rsplit('.').next() {
        Some(ext) => ext.to_ascii_lowercase(),
        None => return false,
    };
    // rsplit returns the whole string if there's no dot; reject filenames with no extension.
    if !relative_path.contains('.') {
        return false;
    }
    ALLOWED_EXTENSIONS.contains(&extension.as_str())
}
