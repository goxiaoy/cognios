//! File-backed secret store for provider API keys.
//!
//! Provider keys are stored in `~/.cogios/.env` as dotenv-style
//! variables such as `COGNIOS_PROVIDER_OPENAI_KEY=...`. The Tauri
//! command layer still talks to this module through `set_secret`,
//! `get_secret`, and `delete_secret` so the IPC surface stays stable.

use std::fs;
use std::path::PathBuf;

const SECRET_ENV_FILE_OVERRIDE: &str = "COGNIOS_SECRETS_ENV_FILE";

fn secret_env_file_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(SECRET_ENV_FILE_OVERRIDE) {
        return Ok(PathBuf::from(path));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "home directory is not available".to_string())?;
    Ok(PathBuf::from(home).join(".cogios").join(".env"))
}

fn env_var_name(account: &str) -> String {
    if let Some(provider_id) = account.strip_prefix("provider:") {
        return format!(
            "COGNIOS_PROVIDER_{}_KEY",
            provider_id.to_ascii_uppercase().replace('-', "_")
        );
    }
    format!(
        "COGNIOS_SECRET_{}",
        account
            .to_ascii_uppercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect::<String>()
    )
}

fn parse_env_key(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, _) = assignment.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

fn parse_env_value(raw: &str) -> String {
    let value = raw.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        let mut out = String::new();
        let mut escaped = false;
        for c in value[1..value.len() - 1].chars() {
            if escaped {
                match c {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    other => out.push(other),
                }
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else {
                out.push(c);
            }
        }
        return out;
    }
    value.to_string()
}

fn quote_env_value(value: &str) -> String {
    if value.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | '@' | '+')
    }) {
        return value.to_string();
    }
    let mut quoted = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

fn read_env_file() -> Result<String, String> {
    let path = secret_env_file_path()?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

fn write_env_file(contents: &str) -> Result<(), String> {
    let path = secret_env_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create {}: {err}", parent.display()))?;
    }
    fs::write(&path, contents).map_err(|err| format!("write {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("chmod {}: {err}", path.display()))?;
    }
    Ok(())
}

/// Set or replace a secret. `account` selects the provider slot.
pub fn set_secret(account: &str, value: &str) -> Result<(), String> {
    let key = env_var_name(account);
    let assignment = format!("{}={}", key, quote_env_value(value));
    let contents = read_env_file()?;
    let mut found = false;
    let mut lines: Vec<String> = contents
        .lines()
        .map(|line| {
            if parse_env_key(line) == Some(key.as_str()) {
                found = true;
                assignment.clone()
            } else {
                line.to_string()
            }
        })
        .collect();
    if !found {
        lines.push(assignment);
    }
    let mut next = lines.join("\n");
    next.push('\n');
    write_env_file(&next)
}

/// Read a secret. Returns `Ok(None)` when no env-file entry exists for
/// the account.
pub fn get_secret(account: &str) -> Result<Option<String>, String> {
    let key = env_var_name(account);
    for line in read_env_file()?.lines() {
        if parse_env_key(line) != Some(key.as_str()) {
            continue;
        }
        let Some((_, raw_value)) = line.split_once('=') else {
            continue;
        };
        let value = parse_env_value(raw_value);
        return Ok(if value.trim().is_empty() {
            None
        } else {
            Some(value.trim().to_string())
        });
    }
    Ok(None)
}

/// Delete a secret. Idempotent so the UI never has to know whether a
/// value existed before.
pub fn delete_secret(account: &str) -> Result<(), String> {
    let path = secret_env_file_path()?;
    if !path.exists() {
        return Ok(());
    }
    let key = env_var_name(account);
    let contents = read_env_file()?;
    let lines: Vec<&str> = contents
        .lines()
        .filter(|line| parse_env_key(line) != Some(key.as_str()))
        .collect();
    let mut next = lines.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    write_env_file(&next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::NamedTempFile;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_env_file<T>(test: impl FnOnce(&PathBuf) -> T) -> T {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let file = NamedTempFile::new().expect("temp env file");
        let path = file.path().to_path_buf();
        std::env::set_var(SECRET_ENV_FILE_OVERRIDE, &path);
        let result = test(&path);
        std::env::remove_var(SECRET_ENV_FILE_OVERRIDE);
        result
    }

    #[test]
    fn set_and_get_round_trip() {
        with_temp_env_file(|_| {
            set_secret("provider:openai", "sk-hello").expect("set");
            let got = get_secret("provider:openai").expect("get");
            assert_eq!(got.as_deref(), Some("sk-hello"));
        });
    }

    #[test]
    fn get_missing_account_returns_none() {
        with_temp_env_file(|_| {
            let got = get_secret("provider:missing").expect("get");
            assert!(got.is_none());
        });
    }

    #[test]
    fn delete_missing_account_is_idempotent() {
        with_temp_env_file(|_| {
            delete_secret("provider:missing").expect("first");
            delete_secret("provider:missing").expect("second");
        });
    }

    #[test]
    fn set_overwrites_existing_value() {
        with_temp_env_file(|_| {
            set_secret("provider:openai", "v1").expect("set v1");
            set_secret("provider:openai", "v2").expect("set v2");
            assert_eq!(
                get_secret("provider:openai").unwrap().as_deref(),
                Some("v2")
            );
        });
    }

    #[test]
    fn preserves_unrelated_env_entries() {
        with_temp_env_file(|path| {
            fs::write(
                path,
                "# comment\nOTHER=value\nCOGNIOS_PROVIDER_OPENAI_KEY=old\n",
            )
            .expect("seed");
            set_secret("provider:openai", "new").expect("set");
            let contents = fs::read_to_string(path).expect("read");
            assert!(contents.contains("# comment\n"));
            assert!(contents.contains("OTHER=value\n"));
            assert!(contents.contains("COGNIOS_PROVIDER_OPENAI_KEY=new\n"));
            assert!(!contents.contains("old"));
        });
    }

    #[test]
    fn delete_removes_only_target_key() {
        with_temp_env_file(|path| {
            fs::write(
                path,
                "COGNIOS_PROVIDER_OPENAI_KEY=sk\nCOGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=qk\n",
            )
            .expect("seed");
            delete_secret("provider:openai").expect("delete");
            let contents = fs::read_to_string(path).expect("read");
            assert!(!contents.contains("COGNIOS_PROVIDER_OPENAI_KEY"));
            assert!(contents.contains("COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY=qk"));
        });
    }
}
