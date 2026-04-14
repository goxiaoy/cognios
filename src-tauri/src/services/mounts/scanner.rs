use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::gitignore::{Gitignore, GitignoreBuilder};

use crate::domain::vfs::node::NodeKind;
use crate::infrastructure::fs::path_mapper::to_relative_path_string;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScannedMountEntry {
    pub relative_path: String,
    pub parent_relative_path: Option<String>,
    pub name: String,
    pub kind: NodeKind,
    pub created_at_epoch: Option<i64>,
    pub modified_at_epoch: Option<i64>,
    pub size_bytes: i64,
}

pub fn scan_mount(root: &Path, ignore_config: &str) -> Result<Vec<ScannedMountEntry>, String> {
    let matcher = build_matcher(root, ignore_config)?;
    let mut entries = Vec::new();
    scan_dir(root, root, &matcher, None, &mut entries)?;
    Ok(entries)
}

fn build_matcher(root: &Path, ignore_config: &str) -> Result<Gitignore, String> {
    let mut builder = GitignoreBuilder::new(root);

    for line in ignore_config.lines() {
        builder
            .add_line(None, line)
            .map_err(|error| error.to_string())?;
    }

    builder.build().map_err(|error| error.to_string())
}

fn scan_dir(
    root: &Path,
    current_dir: &Path,
    matcher: &Gitignore,
    parent_relative_path: Option<String>,
    entries: &mut Vec<ScannedMountEntry>,
) -> Result<(), String> {
    let mut dir_entries = fs::read_dir(current_dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    dir_entries.sort_by_key(|entry| entry.path());

    for entry in dir_entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let is_dir = file_type.is_dir();
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;

        if matcher
            .matched_path_or_any_parents(&path, is_dir)
            .is_ignore()
        {
            continue;
        }

        let relative_path =
            to_relative_path_string(path.strip_prefix(root).map_err(|error| error.to_string())?);
        let next_parent = Some(relative_path.clone());

        entries.push(ScannedMountEntry {
            relative_path,
            parent_relative_path: parent_relative_path.clone(),
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if is_dir {
                NodeKind::Directory
            } else {
                NodeKind::File
            },
            created_at_epoch: to_unix_epoch_seconds(metadata.created().ok())
                .or_else(|| to_unix_epoch_seconds(metadata.modified().ok())),
            modified_at_epoch: to_unix_epoch_seconds(metadata.modified().ok()),
            size_bytes: if is_dir { 0 } else { metadata.len() as i64 },
        });

        if is_dir {
            scan_dir(root, &path, matcher, next_parent, entries)?;
        }
    }

    Ok(())
}

pub fn mount_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub fn normalize_mount_path(path: &str) -> Result<PathBuf, String> {
    let expanded = shellexpand(path);
    let candidate = PathBuf::from(expanded);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;

    if !canonical.is_dir() {
        return Err("mount path must point to a directory".into());
    }

    Ok(canonical)
}

fn shellexpand(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy();
            return if path == "~" {
                home.into_owned()
            } else {
                format!("{home}/{}", &path[2..])
            };
        }
    }

    path.to_string()
}

fn to_unix_epoch_seconds(value: Option<SystemTime>) -> Option<i64> {
    value
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
}
