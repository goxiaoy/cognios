use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::OptionalExtension;
use serde::Deserialize;
use tauri::State;

use crate::services::files::read_file_content::read_file_content as read_file_content_record;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileContentInput {
    pub node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowNodeInFileManagerInput {
    pub node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowNodeExtractArtifactsInput {
    pub node_id: String,
}

#[tauri::command]
pub fn read_file_content(
    state: State<'_, AppState>,
    input: ReadFileContentInput,
) -> Result<String, String> {
    let conn = state
        .db
        .connect()
        .map_err(|_| "file unavailable".to_string())?;
    read_file_content_record(&conn, &input.node_id)
}

#[tauri::command]
pub fn show_node_in_file_manager(
    state: State<'_, AppState>,
    input: ShowNodeInFileManagerInput,
) -> Result<(), String> {
    let conn = state
        .db
        .connect()
        .map_err(|_| "file unavailable".to_string())?;
    let notes_dir = state.storage_dir.join("notes");
    let path = resolve_real_node_path(&conn, &input.node_id, &notes_dir)?;
    reveal_in_file_manager(&path)
}

#[tauri::command]
pub fn show_node_extract_artifacts(
    state: State<'_, AppState>,
    input: ShowNodeExtractArtifactsInput,
) -> Result<(), String> {
    let conn = state
        .db
        .connect()
        .map_err(|_| "extracted files unavailable".to_string())?;
    ensure_extractable_node(&conn, &input.node_id)?;
    let path =
        extract_artifacts_dir(&state.storage_dir).join(safe_extract_path_segment(&input.node_id));
    if !path.is_dir() {
        return Err("Extracted files are not available yet.".into());
    }
    open_directory_in_file_manager(&path)
}

fn resolve_real_node_path(
    conn: &rusqlite::Connection,
    node_id: &str,
    notes_dir: &Path,
) -> Result<PathBuf, String> {
    let record = conn
        .query_row(
            "
            SELECT n.kind, m.absolute_path, n.relative_path
            FROM nodes n
            LEFT JOIN mounts m ON m.node_id = n.id OR m.node_id = n.mount_id
            WHERE n.id = ?1
            ",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "file unavailable".to_string())?;

    match record.0.as_str() {
        "mount" => record
            .1
            .map(PathBuf::from)
            .ok_or_else(|| "file unavailable".to_string()),
        "file" => {
            let mount_root = record.1.ok_or_else(|| "file unavailable".to_string())?;
            let relative_path = record.2.ok_or_else(|| "file unavailable".to_string())?;
            Ok(PathBuf::from(mount_root).join(relative_path))
        }
        "folder" if record.2.is_some() => {
            let mount_root = record.1.ok_or_else(|| "file unavailable".to_string())?;
            let relative_path = record.2.ok_or_else(|| "file unavailable".to_string())?;
            Ok(PathBuf::from(mount_root).join(relative_path))
        }
        "note" => Ok(notes_dir.join(format!("{node_id}.md"))),
        _ => Err("This item does not have a real file path.".into()),
    }
}

fn ensure_extractable_node(conn: &rusqlite::Connection, node_id: &str) -> Result<(), String> {
    let record = conn
        .query_row(
            "SELECT kind, name FROM nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "extracted files unavailable".to_string())?;
    if record.0 != "file" || !has_extract_artifacts_extension(&record.1) {
        return Err("Extracted files are only available for images and PDFs.".into());
    }
    Ok(())
}

fn has_extract_artifacts_extension(name: &str) -> bool {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "gif" | "pdf"
    )
}

fn extract_artifacts_dir(storage_dir: &Path) -> PathBuf {
    storage_dir.join("extract")
}

fn safe_extract_path_segment(value: &str) -> String {
    let mut cleaned = String::new();
    let mut last_was_dash = false;
    for char in value.trim().chars() {
        if char.is_alphanumeric() || matches!(char, '_' | '.' | '-') {
            cleaned.push(char);
            last_was_dash = false;
        } else if !last_was_dash {
            cleaned.push('-');
            last_was_dash = true;
        }
    }
    let cleaned = cleaned.trim_matches(&['.', '-'][..]).to_string();
    if cleaned.is_empty() {
        "node".to_string()
    } else {
        cleaned.chars().take(120).collect()
    }
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("file unavailable".into());
    }

    #[cfg(target_os = "macos")]
    {
        run_command_with_target("open", ["-R"], path)
    }

    #[cfg(target_os = "windows")]
    {
        let select_arg = format!("/select,{}", path.display());
        run_command_without_target("explorer", [select_arg.as_str()])
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        run_command_with_target("xdg-open", std::iter::empty::<&str>(), target)
    }
}

fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("directory unavailable".into());
    }

    #[cfg(target_os = "macos")]
    {
        run_command_with_target("open", std::iter::empty::<&str>(), path)
    }

    #[cfg(target_os = "windows")]
    {
        run_command_with_target("explorer", std::iter::empty::<&str>(), path)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        run_command_with_target("xdg-open", std::iter::empty::<&str>(), path)
    }
}

fn run_command_with_target<'a, I>(program: &str, args: I, target: &Path) -> Result<(), String>
where
    I: IntoIterator<Item = &'a str>,
{
    let status = Command::new(program)
        .args(args)
        .arg(target)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open file manager ({program})"))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        extract_artifacts_dir, has_extract_artifacts_extension, safe_extract_path_segment,
    };

    #[test]
    fn extract_artifact_path_segment_matches_node_id_storage_contract() {
        assert_eq!(
            safe_extract_path_segment("abc/../node id"),
            "abc-..-node-id"
        );
        assert_eq!(safe_extract_path_segment("..."), "node");
    }

    #[test]
    fn extract_artifacts_are_available_for_images_and_pdfs() {
        assert!(has_extract_artifacts_extension("receipt.PNG"));
        assert!(has_extract_artifacts_extension("scan.pdf"));
        assert!(!has_extract_artifacts_extension("note.md"));
    }

    #[test]
    fn extract_artifacts_live_next_to_search_dir() {
        assert_eq!(
            extract_artifacts_dir(Path::new("/tmp/cognios")),
            Path::new("/tmp/cognios").join("extract")
        );
    }
}

#[cfg(target_os = "windows")]
fn run_command_without_target<'a, I>(program: &str, args: I) -> Result<(), String>
where
    I: IntoIterator<Item = &'a str>,
{
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open file manager ({program})"))
    }
}
