use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;

use crate::error::{NextUpError, Result};

/// Envelope encrypted with a locally-held 256-bit key (OS keystore).
/// Layout: MAGIC(8) || nonce(12) || ciphertext.
const MAGIC_LOCAL: &[u8; 8] = b"NXTUPE1\0";

/// Envelope encrypted with a passphrase-derived key (portable backups).
/// Layout: MAGIC(8) || salt(16) || nonce(12) || ciphertext.
const MAGIC_PORTABLE: &[u8; 8] = b"NXTUPP1\0";

const NONCE_LEN: usize = 12;
const SALT_LEN: usize = 16;
pub const KEY_LEN: usize = 32;

fn cipher(key: &[u8; KEY_LEN]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

/// Encrypt with a locally-held master key. A fresh random nonce is generated
/// per call, so encrypting the same plaintext twice yields different bytes.
pub fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes();
    let ciphertext = cipher(key)
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| NextUpError::Crypto("AES-GCM encryption failed".into()))?;

    let mut out = Vec::with_capacity(MAGIC_LOCAL.len() + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC_LOCAL);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a local-key envelope. Fails on wrong key, tampering (GCM tag
/// mismatch) or unrecognized format.
pub fn decrypt(key: &[u8; KEY_LEN], data: &[u8]) -> Result<Vec<u8>> {
    let body = strip_magic(data, MAGIC_LOCAL, NONCE_LEN)?;
    let (nonce, ciphertext) = body.split_at(NONCE_LEN);
    cipher(key)
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| NextUpError::Crypto("decryption failed: wrong key or corrupted data".into()))
}

/// Encrypt with a key derived from a passphrase via Argon2id. Used for
/// portable backups that must be decryptable on another machine where the
/// local OS keystore is unavailable.
pub fn encrypt_with_passphrase(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let salt: [u8; SALT_LEN] = random_bytes();
    let key = derive_key(passphrase, &salt)?;
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes();
    let ciphertext = cipher(&key)
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| NextUpError::Crypto("AES-GCM encryption failed".into()))?;

    let mut out =
        Vec::with_capacity(MAGIC_PORTABLE.len() + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC_PORTABLE);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a passphrase envelope produced by [`encrypt_with_passphrase`].
pub fn decrypt_with_passphrase(passphrase: &str, data: &[u8]) -> Result<Vec<u8>> {
    let body = strip_magic(data, MAGIC_PORTABLE, SALT_LEN + NONCE_LEN)?;
    let (salt, rest) = body.split_at(SALT_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
    let key = derive_key(passphrase, salt)?;
    cipher(&key)
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| {
            NextUpError::Crypto("decryption failed: wrong passphrase or corrupted data".into())
        })
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| NextUpError::Crypto(format!("key derivation failed: {e}")))?;
    Ok(key)
}

fn strip_magic<'a>(data: &'a [u8], magic: &[u8; 8], min_header: usize) -> Result<&'a [u8]> {
    if data.len() < magic.len() + min_header + 16 {
        return Err(NextUpError::Crypto("data too short to be a valid envelope".into()));
    }
    let (head, body) = data.split_at(magic.len());
    if head != magic {
        return Err(NextUpError::Crypto("unrecognized envelope format".into()));
    }
    Ok(body)
}

/// Generate a fresh random 256-bit master key.
pub fn generate_key() -> [u8; KEY_LEN] {
    random_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_roundtrip() {
        let key = generate_key();
        let ct = encrypt(&key, b"hello nextup").unwrap();
        assert_eq!(decrypt(&key, &ct).unwrap(), b"hello nextup");
    }

    #[test]
    fn nonce_is_fresh_per_encryption() {
        let key = generate_key();
        let a = encrypt(&key, b"same").unwrap();
        let b = encrypt(&key, b"same").unwrap();
        assert_ne!(a, b, "two encryptions of identical plaintext must differ");
    }

    #[test]
    fn wrong_key_fails() {
        let ct = encrypt(&generate_key(), b"data").unwrap();
        let err = decrypt(&generate_key(), &ct).unwrap_err();
        assert_eq!(err.kind(), "crypto");
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let key = generate_key();
        let mut ct = encrypt(&key, b"integrity matters").unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0xFF;
        assert!(decrypt(&key, &ct).is_err());
    }

    #[test]
    fn rejects_foreign_format() {
        let key = generate_key();
        assert!(decrypt(&key, b"definitely not an envelope").is_err());
    }

    #[test]
    fn passphrase_roundtrip() {
        let ct = encrypt_with_passphrase("correct horse battery staple", b"portable").unwrap();
        let pt = decrypt_with_passphrase("correct horse battery staple", &ct).unwrap();
        assert_eq!(pt, b"portable");
    }

    #[test]
    fn wrong_passphrase_fails() {
        let ct = encrypt_with_passphrase("right", b"portable").unwrap();
        assert!(decrypt_with_passphrase("wrong", &ct).is_err());
    }

    #[test]
    fn local_and_portable_envelopes_are_distinct() {
        let key = generate_key();
        let local = encrypt(&key, b"x").unwrap();
        // A local envelope must not be readable through the portable path.
        assert!(decrypt_with_passphrase("anything", &local).is_err());
    }
}
