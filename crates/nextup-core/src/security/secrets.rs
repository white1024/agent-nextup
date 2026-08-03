use std::collections::BTreeMap;
use std::path::Path;

use crate::error::{NextUpError, Result};
use crate::security::crypto;
use crate::security::keystore::KeyProvider;
use crate::workspace::atomic::atomic_write;

/// The secrets store is a flat `name -> value` map (API keys, tokens),
/// serialized as JSON and sealed in an AES-256-GCM envelope on disk.
/// Plaintext never touches the filesystem.
pub type SecretMap = BTreeMap<String, String>;

/// Load and decrypt `secrets.enc`. A missing file is treated as an empty
/// store so freshly-imported or hand-cloned workspaces still open.
pub fn load_secrets(path: &Path, keys: &dyn KeyProvider) -> Result<SecretMap> {
    if !path.exists() {
        return Ok(SecretMap::new());
    }
    let sealed = crate::workspace::atomic::read_file(path)?;
    let plaintext = crypto::decrypt(&keys.master_key()?, &sealed)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

/// Encrypt and atomically persist the full map.
pub fn save_secrets(path: &Path, keys: &dyn KeyProvider, map: &SecretMap) -> Result<()> {
    let plaintext = serde_json::to_vec(map)?;
    let sealed = crypto::encrypt(&keys.master_key()?, &plaintext)?;
    atomic_write(path, &sealed)
}

pub fn set_secret(path: &Path, keys: &dyn KeyProvider, name: &str, value: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(NextUpError::InvalidInput("secret name cannot be empty".into()));
    }
    let mut map = load_secrets(path, keys)?;
    map.insert(name.to_string(), value.to_string());
    save_secrets(path, keys, &map)
}

pub fn remove_secret(path: &Path, keys: &dyn KeyProvider, name: &str) -> Result<bool> {
    let mut map = load_secrets(path, keys)?;
    let removed = map.remove(name).is_some();
    if removed {
        save_secrets(path, keys, &map)?;
    }
    Ok(removed)
}

/// Names only — values are never listed wholesale to the UI.
pub fn secret_names(path: &Path, keys: &dyn KeyProvider) -> Result<Vec<String>> {
    Ok(load_secrets(path, keys)?.into_keys().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::keystore::StaticKeyProvider;

    fn provider() -> StaticKeyProvider {
        StaticKeyProvider([42u8; 32])
    }

    #[test]
    fn roundtrip_set_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        let kp = provider();

        set_secret(&path, &kp, "ANTHROPIC_API_KEY", "sk-ant-xxx").unwrap();
        set_secret(&path, &kp, "OPENAI_API_KEY", "sk-yyy").unwrap();

        let map = load_secrets(&path, &kp).unwrap();
        assert_eq!(map.get("ANTHROPIC_API_KEY").unwrap(), "sk-ant-xxx");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn file_on_disk_is_not_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        let kp = provider();
        set_secret(&path, &kp, "TOKEN", "super-secret-value").unwrap();

        let raw = std::fs::read(&path).unwrap();
        let raw_str = String::from_utf8_lossy(&raw);
        assert!(!raw_str.contains("super-secret-value"));
        assert!(!raw_str.contains("TOKEN"));
    }

    #[test]
    fn missing_file_is_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let map = load_secrets(&dir.path().join("nope.enc"), &provider()).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn wrong_key_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        set_secret(&path, &provider(), "A", "B").unwrap();

        let other = StaticKeyProvider([9u8; 32]);
        assert!(load_secrets(&path, &other).is_err());
    }

    #[test]
    fn remove_and_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.enc");
        let kp = provider();
        set_secret(&path, &kp, "A", "1").unwrap();
        set_secret(&path, &kp, "B", "2").unwrap();

        assert!(remove_secret(&path, &kp, "A").unwrap());
        assert!(!remove_secret(&path, &kp, "A").unwrap());
        assert_eq!(secret_names(&path, &kp).unwrap(), vec!["B".to_string()]);
    }

    #[test]
    fn empty_name_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = set_secret(&dir.path().join("s.enc"), &provider(), "  ", "v").unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }
}
