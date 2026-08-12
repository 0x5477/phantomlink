//! Encrypted local file storage. Files are stored as AES-256-GCM encrypted blobs
//! with SHA-256 hash filenames (no original names on disk).

use sha2::Digest;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use crate::crypto;

pub struct FileStore {
    base_dir: PathBuf,
}

impl FileStore {
    pub fn new(base_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(base_dir).map_err(|e| format!("mkdir file store: {e}"))?;
        Ok(Self {
            base_dir: base_dir.to_path_buf(),
        })
    }

    /// Compute SHA-256 hex of raw file data.
    pub fn sha256_hex(data: &[u8]) -> String {
        let mut hasher = sha2::Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex_encode(&result)
    }

    /// Store a file encrypted with the file storage key.
    /// Returns the stored filename (sha256 hex).
    pub fn store(
        &self,
        file_key: &Zeroizing<[u8; 32]>,
        data: &[u8],
    ) -> Result<String, String> {
        let hash = Self::sha256_hex(data);
        let stored_name = format!("{hash}.enc");
        let path = self.base_dir.join(&stored_name);

        // Encrypt the whole file
        let (ct, nonce) = crypto::encrypt(file_key.as_ref(), data, b"file")?;
        let mut packed = Vec::with_capacity(crypto::NONCE_LEN + ct.len());
        packed.extend_from_slice(&nonce);
        packed.extend_from_slice(&ct);

        std::fs::write(&path, &packed).map_err(|e| format!("write file: {e}"))?;
        Ok(stored_name)
    }

    /// Load and decrypt a stored file.
    pub fn load(
        &self,
        file_key: &Zeroizing<[u8; 32]>,
        stored_name: &str,
    ) -> Result<Vec<u8>, String> {
        let path = self.base_dir.join(stored_name);
        let packed = std::fs::read(&path).map_err(|e| format!("read file: {e}"))?;
        if packed.len() < crypto::NONCE_LEN {
            return Err("file too short".into());
        }
        let nonce: [u8; crypto::NONCE_LEN] = packed[..crypto::NONCE_LEN].try_into().unwrap();
        let ct = &packed[crypto::NONCE_LEN..];
        crypto::decrypt(file_key.as_ref(), ct, &nonce, b"file")
    }

    /// Delete a stored file.
    pub fn delete(&self, stored_name: &str) -> Result<(), String> {
        let path = self.base_dir.join(stored_name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("delete file: {e}"))?;
        }
        Ok(())
    }

    /// Get the base directory path.
    pub fn base_path(&self) -> &Path {
        &self.base_dir
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
