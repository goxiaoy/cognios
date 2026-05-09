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
