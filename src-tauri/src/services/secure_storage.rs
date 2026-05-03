//! OS-keychain-backed secret store.
//!
//! Wraps the `keyring` crate so the rest of the app talks to a
//! single, testable surface for storing/retrieving cloud-provider
//! API keys.
//!
//! The service name is fixed at `cognios-search`; the *account* is
//! the secret's identifier (e.g. `"provider:openai"`). All errors
//! flatten to `String` so they cross the Tauri command boundary
//! cleanly.

use keyring::Entry;

/// Service name used as the keychain group identifier. Bumping this
/// orphans existing keychain entries — be deliberate.
const SERVICE_NAME: &str = "cognios-search";

/// Set or replace a secret. `account` selects the slot.
pub fn set_secret(account: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|err| format!("keyring open: {err}"))?;
    entry
        .set_password(value)
        .map_err(|err| format!("keyring set: {err}"))
}

/// Read a secret. Returns `Ok(None)` when no entry exists for that
/// account — the keychain has never had a value written, or the
/// user deleted it via Keychain Access.
pub fn get_secret(account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|err| format!("keyring open: {err}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring get: {err}")),
    }
}

/// Delete a secret. Idempotent — deleting a non-existent entry is
/// not an error so the UI's "Forget token" button never has to know
/// whether anything was there before.
pub fn delete_secret(account: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|err| format!("keyring open: {err}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring delete: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The secure_storage module talks to the host's real keychain,
    /// which on macOS pops a Security Agent prompt the first time
    /// the running binary touches an entry. In any non-interactive
    /// environment (CI, `cargo test` without a logged-in GUI session,
    /// containers) that prompt blocks indefinitely. We therefore
    /// gate every keychain-touching test on the ``COGNIOS_KEYRING_TESTS=1``
    /// environment variable; developers who want to exercise the
    /// roundtrip locally set the env var, accept the Keychain Access
    /// dialog once, and the tests then run inline. The Tauri command
    /// + JS-side hook provide enough coverage for the IPC contract;
    /// these tests pin the wrapper itself.
    fn keyring_tests_enabled() -> bool {
        std::env::var("COGNIOS_KEYRING_TESTS").as_deref() == Ok("1")
    }

    #[test]
    fn set_and_get_round_trip() {
        if !keyring_tests_enabled() {
            return;
        }
        let account = format!("test-roundtrip-{}", std::process::id());
        set_secret(&account, "hello world").expect("set");
        let got = get_secret(&account).expect("get");
        assert_eq!(got.as_deref(), Some("hello world"));
        delete_secret(&account).expect("delete");
    }

    #[test]
    fn get_missing_account_returns_none() {
        if !keyring_tests_enabled() {
            return;
        }
        let account = format!("test-never-set-{}", std::process::id());
        let _ = delete_secret(&account);
        let got = get_secret(&account).expect("get");
        assert!(got.is_none());
    }

    #[test]
    fn delete_missing_account_is_idempotent() {
        if !keyring_tests_enabled() {
            return;
        }
        let account = format!("test-idempotent-delete-{}", std::process::id());
        delete_secret(&account).expect("first");
        delete_secret(&account).expect("second");
    }

    #[test]
    fn set_overwrites_existing_value() {
        if !keyring_tests_enabled() {
            return;
        }
        let account = format!("test-overwrite-{}", std::process::id());
        set_secret(&account, "v1").expect("set v1");
        set_secret(&account, "v2").expect("set v2");
        assert_eq!(get_secret(&account).unwrap().as_deref(), Some("v2"));
        delete_secret(&account).expect("cleanup");
    }
}
