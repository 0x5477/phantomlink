//! Cryptographic primitives: Argon2id KDF, AES-256-GCM, X25519 ECDH, HKDF, Ed25519.

use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::Aead;
use argon2::{Argon2, Algorithm, Version, Params};
use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Argon2id parameters: 64 MiB memory, 3 iterations, 4 parallel lanes.
pub const ARGON2_M_COST: u32 = 65536;
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 4;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;

/// Derive a 256-bit master key from password + salt using Argon2id.
pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(KEY_LEN))
        .map_err(|e| format!("argon2 params: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon2.hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| format!("argon2 derive: {e}"))?;
    Ok(out)
}

/// Derive a sub-key from master key using HKDF-SHA256.
 pub fn hkdf_derive(master: &[u8], context: &str) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::from_prk(master).expect("hkdf from prk");
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(context.as_bytes(), okm.as_mut()).expect("hkdf expand");
    okm
}

pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub fn generate_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

/// AES-256-GCM encrypt. Returns (ciphertext, nonce).
pub fn encrypt(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<(Vec<u8>, [u8; NONCE_LEN]), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {e}"))?;
    let nonce_bytes = generate_nonce();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let payload = aes_gcm::aead::Payload { msg: plaintext, aad };
    let ct = cipher.encrypt(nonce, payload).map_err(|e| format!("aes encrypt: {e}"))?;
    Ok((ct, nonce_bytes))
}

/// AES-256-GCM decrypt.
pub fn decrypt(key: &[u8], ciphertext: &[u8], nonce: &[u8; NONCE_LEN], aad: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("aes key: {e}"))?;
    let nonce = Nonce::from_slice(nonce);
    let payload = aes_gcm::aead::Payload { msg: ciphertext, aad };
    cipher.decrypt(nonce, payload).map_err(|e| format!("aes decrypt: {e}"))
}

/// Convenience: encrypt + base64-encode (for DB storage).
pub fn encrypt_field(key: &[u8], plaintext: &[u8]) -> Result<String, String> {
    let (ct, nonce) = encrypt(key, plaintext, b"field")?;
    let mut packed = Vec::with_capacity(NONCE_LEN + ct.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ct);
    Ok(general_purpose::STANDARD.encode(&packed))
}

/// Convenience: base64-decode + decrypt.
pub fn decrypt_field(key: &[u8], packed_b64: &str) -> Result<Vec<u8>, String> {
    let packed = general_purpose::STANDARD.decode(packed_b64).map_err(|e| format!("b64 decode: {e}"))?;
    if packed.len() < NONCE_LEN { return Err("packed too short".into()); }
    let nonce: [u8; NONCE_LEN] = packed[..NONCE_LEN].try_into().unwrap();
    let ct = &packed[NONCE_LEN..];
    decrypt(key, ct, &nonce, b"field")
}

// ---- Ed25519 ----

pub fn generate_ed25519_keypair() -> (SigningKey, VerifyingKey) {
    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let signing = SigningKey::from_bytes(&secret_bytes);
    let verifying = signing.verifying_key();
    (signing, verifying)
}

pub fn ed25519_sign(signing: &SigningKey, data: &[u8]) -> Signature {
    signing.sign(data)
}

pub fn ed25519_verify(public: &VerifyingKey, data: &[u8], sig: &Signature) -> bool {
    public.verify(data, sig).is_ok()
}

pub fn fingerprint_hex(public_key: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(public_key);
    let hash = hasher.finalize();
    hash[..16].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

// ---- X25519 ----

use x25519_dalek::{EphemeralSecret, PublicKey as X25519PublicKey};

pub fn generate_x25519_keypair() -> (EphemeralSecret, X25519PublicKey) {
    let secret = EphemeralSecret::random_from_rng(&mut OsRng);
    let public = X25519PublicKey::from(&secret);
    (secret, public)
}

pub fn x25519_dh(secret: EphemeralSecret, public: &X25519PublicKey) -> [u8; 32] {
    secret.diffie_hellman(public).to_bytes()
}

pub fn derive_session_key(shared: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::from_prk(shared).expect("hkdf from dh");
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(b"phantomlink-session-v1", okm.as_mut()).expect("hkdf expand");
    okm
}

pub fn generate_pairing_code() -> String {
    let mut buf = [0u8; 4];
    OsRng.fill_bytes(&mut buf);
    let num = u32::from_le_bytes(buf) % 1_000_000;
    format!("{num:06}")
}
