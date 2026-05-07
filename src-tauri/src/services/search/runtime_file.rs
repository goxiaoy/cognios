//! Reads `~/.cogios/search/sidecar.runtime` — the rendezvous file the
//! Python sidecar writes once it has bound a loopback port and generated
//! its bearer token. Rust uses the parsed `(port, token)` for every
//! authenticated HTTP call into the sidecar.
//!
//! Security contract (see plan Architecture / Sidecar Boundaries):
//!
//! - The file lives under `~/.cogios/search/`, mode 0600 (sidecar's
//!   responsibility to write it that way; Rust does not enforce mode but
//!   logs a warning if it is more permissive).
//! - The file MUST NOT be a symlink. Rust rejects symlinks via
//!   `fs::symlink_metadata` before opening — defends against a
//!   substitution attack where a co-resident process drops a symlink to
//!   forge a different `(port, token)`.
//! - The token is a 256-bit value rendered as 64 lowercase hex chars.
//!   Anything else parses as `RuntimeFileError::InvalidToken`.
//! - The port must be in the ephemeral range (1..=65535).
//!
//! This module is intentionally pure logic — no Tauri, no shell, no
//! tokio. The supervisor (`super::supervisor`) handles the lifecycle.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct RuntimeFile {
    pub port: u16,
    pub token: String,
}

#[derive(Debug)]
pub enum RuntimeFileError {
    NotFound(PathBuf),
    IsSymlink(PathBuf),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Malformed {
        path: PathBuf,
        source: serde_json::Error,
    },
    InvalidToken,
    InvalidPort(u32),
}

impl std::fmt::Display for RuntimeFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(p) => write!(f, "runtime file not found at {}", p.display()),
            Self::IsSymlink(p) => write!(
                f,
                "runtime file at {} is a symlink — refusing to read for security",
                p.display()
            ),
            Self::Io { path, source } => {
                write!(
                    f,
                    "runtime file at {} could not be read: {source}",
                    path.display()
                )
            }
            Self::Malformed { path, source } => {
                write!(
                    f,
                    "runtime file at {} is malformed JSON: {source}",
                    path.display()
                )
            }
            Self::InvalidToken => write!(f, "runtime file token is not a 64-char hex string"),
            Self::InvalidPort(p) => write!(f, "runtime file port {p} is invalid"),
        }
    }
}

impl std::error::Error for RuntimeFileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Malformed { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Reads the runtime file at `path`, validating that it is not a symlink
/// and that the token + port satisfy their format invariants.
pub fn read_runtime_file(path: &Path) -> Result<RuntimeFile, RuntimeFileError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(RuntimeFileError::NotFound(path.to_path_buf()));
        }
        Err(source) => {
            return Err(RuntimeFileError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    if metadata.file_type().is_symlink() {
        return Err(RuntimeFileError::IsSymlink(path.to_path_buf()));
    }

    let bytes = fs::read(path).map_err(|source| RuntimeFileError::Io {
        path: path.to_path_buf(),
        source,
    })?;

    #[derive(Deserialize)]
    struct Raw {
        port: u32,
        token: String,
    }

    let raw: Raw =
        serde_json::from_slice(&bytes).map_err(|source| RuntimeFileError::Malformed {
            path: path.to_path_buf(),
            source,
        })?;

    if !is_valid_token(&raw.token) {
        return Err(RuntimeFileError::InvalidToken);
    }

    if raw.port == 0 || raw.port > u16::MAX as u32 {
        return Err(RuntimeFileError::InvalidPort(raw.port));
    }

    Ok(RuntimeFile {
        port: raw.port as u16,
        token: raw.token,
    })
}

/// Token format: 64 lowercase hex chars (256 bits).
fn is_valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn write_runtime(dir: &Path, contents: &str, mode: Option<u32>) -> PathBuf {
        let path = dir.join("sidecar.runtime");
        fs::write(&path, contents).expect("write");
        if let Some(mode) = mode {
            let mut perms = fs::metadata(&path).expect("metadata").permissions();
            perms.set_mode(mode);
            fs::set_permissions(&path, perms).expect("chmod");
        }
        path
    }

    fn valid_token() -> String {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into()
    }

    #[test]
    fn reads_well_formed_runtime_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_runtime(
            dir.path(),
            &format!(r#"{{ "port": 53127, "token": "{}" }}"#, valid_token()),
            Some(0o600),
        );
        let runtime = read_runtime_file(&path).expect("parses");
        assert_eq!(runtime.port, 53127);
        assert_eq!(runtime.token, valid_token());
    }

    #[test]
    fn rejects_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = read_runtime_file(&dir.path().join("absent.runtime")).expect_err("err");
        assert!(matches!(err, RuntimeFileError::NotFound(_)));
    }

    #[test]
    fn rejects_symlink() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = write_runtime(
            dir.path(),
            &format!(r#"{{ "port": 1, "token": "{}" }}"#, valid_token()),
            None,
        );
        let link = dir.path().join("link.runtime");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let err = read_runtime_file(&link).expect_err("symlink rejected");
        assert!(matches!(err, RuntimeFileError::IsSymlink(_)));
    }

    #[test]
    fn rejects_malformed_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_runtime(dir.path(), "not json at all", None);
        let err = read_runtime_file(&path).expect_err("malformed");
        assert!(matches!(err, RuntimeFileError::Malformed { .. }));
    }

    #[test]
    fn rejects_short_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_runtime(dir.path(), r#"{ "port": 1, "token": "abc" }"#, None);
        let err = read_runtime_file(&path).expect_err("short token");
        assert!(matches!(err, RuntimeFileError::InvalidToken));
    }

    #[test]
    fn rejects_uppercase_hex_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let upper = "0".repeat(63) + "A";
        let path = write_runtime(
            dir.path(),
            &format!(r#"{{ "port": 1, "token": "{upper}" }}"#),
            None,
        );
        let err = read_runtime_file(&path).expect_err("uppercase rejected");
        assert!(matches!(err, RuntimeFileError::InvalidToken));
    }

    #[test]
    fn rejects_zero_port() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_runtime(
            dir.path(),
            &format!(r#"{{ "port": 0, "token": "{}" }}"#, valid_token()),
            None,
        );
        let err = read_runtime_file(&path).expect_err("port 0");
        assert!(matches!(err, RuntimeFileError::InvalidPort(0)));
    }

    #[test]
    fn rejects_oversized_port() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_runtime(
            dir.path(),
            &format!(r#"{{ "port": 70000, "token": "{}" }}"#, valid_token()),
            None,
        );
        let err = read_runtime_file(&path).expect_err("port too big");
        assert!(matches!(err, RuntimeFileError::InvalidPort(70000)));
    }
}
