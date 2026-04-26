use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::services::mounts::scanner::{mount_display_name, normalize_mount_path};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianVault {
    pub name: String,
    pub path: String,
    pub source: &'static str,
}

pub fn detect_obsidian_vaults() -> Vec<ObsidianVault> {
    let Some(config_path) = obsidian_config_path() else {
        return Vec::new();
    };

    let Ok(raw) = fs::read_to_string(config_path) else {
        return Vec::new();
    };

    parse_obsidian_vaults(&raw)
}

fn obsidian_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        home_dir().map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("obsidian")
                .join("obsidian.json")
        })
    }

    #[cfg(target_os = "linux")]
    {
        home_dir().map(|home| home.join(".config").join("obsidian").join("obsidian.json"))
    }

    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("obsidian").join("obsidian.json"))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn parse_obsidian_vaults(raw: &str) -> Vec<ObsidianVault> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(vaults) = value.get("vaults").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut seen_paths = HashSet::new();
    let mut detected = Vec::new();

    for vault in vaults.values() {
        let Some(path) = vault.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Ok(normalized) = normalize_mount_path(path) else {
            continue;
        };
        let normalized_path = normalized.to_string_lossy().into_owned();
        if !seen_paths.insert(normalized_path.clone()) {
            continue;
        }

        detected.push(ObsidianVault {
            name: mount_display_name(Path::new(&normalized_path)),
            path: normalized_path,
            source: "obsidian",
        });
    }

    detected.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    detected
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::parse_obsidian_vaults;

    #[test]
    fn parses_vault_paths_from_obsidian_config() {
        let alpha = tempdir().expect("alpha vault");
        let beta = tempdir().expect("beta vault");
        let raw = r#"{
          "vaults": {
            "a": { "path": "__ALPHA__" },
            "b": { "path": "__BETA__" }
          }
        }"#;
        let raw = raw
            .replace("__ALPHA__", &alpha.path().to_string_lossy())
            .replace("__BETA__", &beta.path().to_string_lossy());

        let vaults = parse_obsidian_vaults(&raw);
        let alpha_path = alpha
            .path()
            .canonicalize()
            .expect("canonical alpha")
            .to_string_lossy()
            .into_owned();
        let beta_path = beta
            .path()
            .canonicalize()
            .expect("canonical beta")
            .to_string_lossy()
            .into_owned();

        assert_eq!(vaults.len(), 2);
        assert_eq!(vaults[0].source, "obsidian");
        assert!(vaults.iter().any(|vault| vault.path == alpha_path));
        assert!(vaults.iter().any(|vault| vault.path == beta_path));
    }
}
