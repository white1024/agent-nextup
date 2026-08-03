use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::error::{NextUpError, Result};
use crate::security::crypto::{generate_key, KEY_LEN};

/// Port: supplies the 256-bit master key used to encrypt `secrets.enc`.
///
/// Production uses [`OsKeyringProvider`]; tests use [`StaticKeyProvider`] so
/// no OS credential store is touched during `cargo test`.
pub trait KeyProvider: Send + Sync {
    /// Returns the master key, **creating and persisting one if none exists**.
    /// Call it only from a path that is about to encrypt or decrypt something.
    fn master_key(&self) -> Result<[u8; KEY_LEN]>;

    /// Whether a master key already exists — **read-only, never creates one**
    /// (D103). Anything that just wants to report status must use this: asking
    /// `master_key()` for a yes/no answer leaves a real credential behind in
    /// the user's OS store as a side effect of rendering a dashboard.
    fn master_key_exists(&self) -> bool;

    /// Human-readable description of where the key lives (shown in the UI).
    fn describe(&self) -> String;
}

/// Stores a random master key in the OS credential store via the `keyring`
/// crate (Windows Credential Manager on this platform). The key is created
/// lazily on first use and reused afterwards, so the user never types a
/// password and no key material is written to disk in plaintext.
pub struct OsKeyringProvider {
    service: String,
    account: String,
}

impl Default for OsKeyringProvider {
    fn default() -> Self {
        Self {
            service: "agent-nextup".into(),
            account: "master-key".into(),
        }
    }
}

impl OsKeyringProvider {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &self.account)
            .map_err(|e| NextUpError::Keystore(format!("cannot open credential entry: {e}")))
    }
}

impl KeyProvider for OsKeyringProvider {
    fn master_key(&self) -> Result<[u8; KEY_LEN]> {
        let entry = self.entry()?;
        match entry.get_password() {
            Ok(encoded) => {
                let bytes = BASE64
                    .decode(encoded.trim())
                    .map_err(|e| NextUpError::Keystore(format!("stored key is corrupted: {e}")))?;
                bytes.try_into().map_err(|_| {
                    NextUpError::Keystore("stored key has invalid length".into())
                })
            }
            Err(keyring::Error::NoEntry) => {
                let key = generate_key();
                entry
                    .set_password(&BASE64.encode(key))
                    .map_err(|e| NextUpError::Keystore(format!("cannot persist master key: {e}")))?;
                Ok(key)
            }
            Err(e) => Err(NextUpError::Keystore(format!(
                "cannot read master key from OS credential store: {e}"
            ))),
        }
    }

    fn master_key_exists(&self) -> bool {
        // An unreachable store and an empty one both answer "no key to report".
        // The distinction matters to `master_key`, which surfaces the error;
        // here the caller only wants a status flag, so both collapse to false.
        match self.entry().map(|e| e.get_password()) {
            Ok(Ok(_)) => true,
            _ => false,
        }
    }

    fn describe(&self) -> String {
        format!("OS credential store ({}/{})", self.service, self.account)
    }
}

/// Fixed-key provider for unit tests and headless environments.
pub struct StaticKeyProvider(pub [u8; KEY_LEN]);

impl KeyProvider for StaticKeyProvider {
    fn master_key(&self) -> Result<[u8; KEY_LEN]> {
        Ok(self.0)
    }

    fn master_key_exists(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "static test key".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_provider_returns_its_key() {
        let key = [7u8; KEY_LEN];
        let provider = StaticKeyProvider(key);
        assert_eq!(provider.master_key().unwrap(), key);
    }
}
