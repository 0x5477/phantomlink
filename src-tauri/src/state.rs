//! Global runtime state: encryption keys live only in memory, zeroized on lock.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use zeroize::Zeroizing;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub files_dir: PathBuf,
    pub device_id: String,
    /// Master key derived from Argon2id; None when locked.
    master_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    /// Database encryption key derived via HKDF from master key.
    db_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    /// File storage encryption key derived via HKDF from master key.
    file_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    pub failed_attempts: Mutex<u32>,
    pub lockout_until: Mutex<Option<Instant>>,
    /// Whether this is first-run (no vault created yet).
    pub initialized: Mutex<bool>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, device_id: String) -> Self {
        let db_path = data_dir.join(".pl_cache");
        let files_dir = data_dir.join(".pl_assets");
        Self {
            data_dir,
            db_path,
            files_dir,
            device_id,
            master_key: Mutex::new(None),
            db_key: Mutex::new(None),
            file_key: Mutex::new(None),
            failed_attempts: Mutex::new(0),
            lockout_until: Mutex::new(None),
            initialized: Mutex::new(false),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.master_key.lock().unwrap().is_some()
    }

    pub fn get_db_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        self.db_key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "vault locked".to_string())
    }

    pub fn get_file_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        self.file_key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "vault locked".to_string())
    }

    pub fn get_master_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        self.master_key
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "vault locked".to_string())
    }

    /// Store all derived keys after successful unlock.
    pub fn set_keys(
        &self,
        master: Zeroizing<[u8; 32]>,
        dbk: Zeroizing<[u8; 32]>,
        fsk: Zeroizing<[u8; 32]>,
    ) {
        *self.master_key.lock().unwrap() = Some(master);
        *self.db_key.lock().unwrap() = Some(dbk);
        *self.file_key.lock().unwrap() = Some(fsk);
    }

    /// Clear all keys from memory (called on lock).
    pub fn clear_keys(&self) {
        *self.master_key.lock().unwrap() = None;
        *self.db_key.lock().unwrap() = None;
        *self.file_key.lock().unwrap() = None;
    }

    pub fn set_initialized(&self, val: bool) {
        *self.initialized.lock().unwrap() = val;
    }

    pub fn is_initialized(&self) -> bool {
        *self.initialized.lock().unwrap()
    }
}
