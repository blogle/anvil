use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

pub const BLOB_PREFIX: &str = "v1:";
pub const KEY_ENV: &str = "ANVIL_SECRET_KEY";
pub const KEY_FILE: &str = "secret.key";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("the master key in {location} is not 64 hex characters")]
    BadKey { location: String },
    #[error(
        "no master key: set {KEY_ENV} to 64 hex characters (e.g. `openssl rand -hex 32` in your .env, or a k8s Secret) or provide {KEY_FILE} beside the store"
    )]
    MissingKey,
    #[error("cannot read the master key file: {message}")]
    KeyFile { message: String },
    #[error(
        "the stored secret could not be decrypted — was it written under a different master key?"
    )]
    WrongKey,
    #[error("randomness unavailable: {0}")]
    Random(String),
}

#[derive(Clone)]
pub struct SecretBox {
    cipher: ChaCha20Poly1305,
}

impl SecretBox {
    pub fn from_key(key: [u8; 32]) -> Self {
        Self {
            cipher: ChaCha20Poly1305::new(Key::from_slice(&key)),
        }
    }

    pub fn bootstrap(dir: &Path) -> Result<Self, SecretError> {
        if let Ok(hex) = std::env::var(KEY_ENV) {
            return Self::from_hex(&hex, KEY_ENV);
        }
        let path = dir.join(KEY_FILE);
        if !path.exists() {
            return Err(SecretError::MissingKey);
        }
        let hex = std::fs::read_to_string(&path).map_err(|error| SecretError::KeyFile {
            message: error.to_string(),
        })?;
        Self::from_hex(hex.trim(), &path.display().to_string())
    }

    fn from_hex(hex: &str, source: &str) -> Result<Self, SecretError> {
        let key = hex_decode(hex).ok_or(SecretError::BadKey {
            location: source.to_owned(),
        })?;
        if key.len() != 32 {
            return Err(SecretError::BadKey {
                location: source.to_owned(),
            });
        }
        let mut material = [0u8; 32];
        material.copy_from_slice(&key);
        Ok(Self::from_key(material))
    }

    pub fn seal(&self, plaintext: &str) -> Result<String, SecretError> {
        let mut nonce_bytes = [0u8; 12];
        fill_random(&mut nonce_bytes)?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, Payload::from(plaintext.as_bytes()))
            .map_err(|_| SecretError::WrongKey)?;
        let mut blob = nonce_bytes.to_vec();
        blob.extend(ciphertext);
        Ok(format!("{BLOB_PREFIX}{}", hex_encode(&blob)))
    }

    pub fn open(&self, blob: &str) -> Result<Option<String>, SecretError> {
        let Some(encoded) = blob.strip_prefix(BLOB_PREFIX) else {
            return Ok(None);
        };
        let bytes = hex_decode(encoded).ok_or(SecretError::WrongKey)?;
        if bytes.len() < 13 {
            return Err(SecretError::WrongKey);
        }
        let (nonce_bytes, ciphertext) = bytes.split_at(12);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce_bytes), Payload::from(ciphertext))
            .map_err(|_| SecretError::WrongKey)?;
        String::from_utf8(plaintext)
            .map(Some)
            .map_err(|_| SecretError::WrongKey)
    }
}

fn fill_random(bytes: &mut [u8]) -> Result<(), SecretError> {
    getrandom::fill(bytes).map_err(|error| SecretError::Random(error.to_string()))
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}
