//! Global runtime state: encryption keys live only in memory, zeroized on purge.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use zeroize::Zeroizing;

pub struct AppState {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub files_dir: PathBuf,
    pub device_id: String,
    master_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    db_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    file_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    pub failed_attempts: Mutex<u32>,
    pub lockout_until: Mutex<Option<Instant>>,
    pub initialized: Mutex<bool>,
    /// UI-level lock flag. Keys stay in memory so messages can still be received.
    pub ui_locked: AtomicBool,
    /// Attack detection counter for self-destruct.
    pub attack_count: AtomicU32,
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
            ui_locked: AtomicBool::new(false),
            attack_count: AtomicU32::new(0),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.master_key.lock().unwrap().is_some()
    }

    pub fn is_ui_locked(&self) -> bool {
        self.ui_locked.load(Ordering::Relaxed)
    }

    pub fn set_ui_locked(&self, val: bool) {
        self.ui_locked.store(val, Ordering::Relaxed);
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

    /// Full purge: zeroize all keys from memory.
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

    pub fn record_attack(&self) -> u32 {
        self.attack_count.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn reset_attacks(&self) {
        self.attack_count.store(0, Ordering::Relaxed);
    }

    pub fn get_attack_count(&self) -> u32 {
        self.attack_count.load(Ordering::Relaxed)
    }
}
