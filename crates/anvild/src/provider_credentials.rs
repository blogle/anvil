//! Encryption primitives for provider API keys stored by the controller.
//!
//! Construct a [`ProviderSealer`] with [`ProviderSealer::from_hex`] and a 64-character
//! hexadecimal encoding of exactly 32 key bytes. Keep the input key outside the database
//! and do not log it.

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::Serialize;
use thiserror::Error;

const NONCE_LENGTH: usize = 12;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProviderSealerError {
    #[error("encryption key must be 64 hexadecimal characters")]
    InvalidKey,
    #[error("secure random nonce generation failed")]
    Randomness,
    #[error("provider credential encryption or authentication failed")]
    Encryption,
}

/// Encrypts provider keys with AES-256-GCM.
///
/// `from_hex` accepts exactly 32 bytes encoded as 64 ASCII hexadecimal characters.
pub struct ProviderSealer {
    cipher: LessSafeKey,
}

impl ProviderSealer {
    /// Create a sealer from a 32-byte key represented by exactly 64 hex characters.
    pub fn from_hex(key: &str) -> Result<Self, ProviderSealerError> {
        if key.len() != 64 || !key.is_ascii() {
            return Err(ProviderSealerError::InvalidKey);
        }
        let mut decoded = [0u8; 32];
        for (index, byte) in decoded.iter_mut().enumerate() {
            let start = index * 2;
            *byte = u8::from_str_radix(&key[start..start + 2], 16)
                .map_err(|_| ProviderSealerError::InvalidKey)?;
        }
        let unbound = UnboundKey::new(&aead::AES_256_GCM, &decoded)
            .map_err(|_| ProviderSealerError::InvalidKey)?;
        let cipher = LessSafeKey::new(unbound);
        decoded.fill(0);
        Ok(Self { cipher })
    }

    pub(crate) fn seal(
        &self,
        provider: &str,
        generation: i64,
        plaintext: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), ProviderSealerError> {
        let mut nonce = [0u8; NONCE_LENGTH];
        getrandom::getrandom(&mut nonce).map_err(|_| ProviderSealerError::Randomness)?;
        let aad = associated_data(provider, generation);
        let mut ciphertext = plaintext.to_vec();
        self.cipher
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad.as_slice()),
                &mut ciphertext,
            )
            .map_err(|_| ProviderSealerError::Encryption)?;
        Ok((ciphertext, nonce.to_vec()))
    }

    pub(crate) fn open(
        &self,
        provider: &str,
        generation: i64,
        ciphertext: &[u8],
        nonce: &[u8],
    ) -> Result<Vec<u8>, ProviderSealerError> {
        let nonce: [u8; NONCE_LENGTH] = nonce
            .try_into()
            .map_err(|_| ProviderSealerError::Encryption)?;
        let aad = associated_data(provider, generation);
        let mut plaintext = ciphertext.to_vec();
        let plaintext = self
            .cipher
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad.as_slice()),
                &mut plaintext,
            )
            .map_err(|_| ProviderSealerError::Encryption)?;
        Ok(plaintext.to_vec())
    }
}

fn associated_data(provider: &str, generation: i64) -> Vec<u8> {
    format!("anvil-provider-key-v1\0{provider}\0{generation}").into_bytes()
}

/// Non-secret identifying metadata for one persisted provider key generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderCredentialMetadata {
    pub provider_id: String,
    pub generation: i64,
    pub created_at: String,
    pub kind: String,
}

/// Credential data used by the controller when importing provider credentials.
/// This type deliberately remains crate-private so secret-bearing entries do not
/// become part of the browser-facing API.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderCredential {
    pub(crate) kind: ProviderCredentialKind,
    pub(crate) entry: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderCredentialKind {
    Key,
    OAuth,
}
