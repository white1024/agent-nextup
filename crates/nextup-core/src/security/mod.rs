//! Security module: local encryption of sensitive configuration.
//!
//! - `crypto`: AES-256-GCM file envelopes (local-key and passphrase-derived).
//! - `keystore`: master key management behind the `KeyProvider` port; the
//!   production adapter stores a random 256-bit key in the OS credential
//!   store (Windows Credential Manager / macOS Keychain / Secret Service).
//! - `secrets`: encrypted key-value store persisted as `.nextup/secrets.enc`.

pub mod crypto;
pub mod keystore;
pub mod secrets;
