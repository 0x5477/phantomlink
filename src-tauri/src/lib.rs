//! PhantomLink application logic and Tauri command bindings.

mod crypto;
mod db;
mod file_store;
mod network;
mod protocol;
mod state;

use std::sync::Arc;
use tauri::{Manager, State, Emitter};
use base64::Engine as _;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use db::{ChatMessage, Conversation, Database, Device, FileRecord, Message};
use protocol::Frame;

// ---- Vault lifecycle ----

/// Check if a vault exists (first-run detection).
#[tauri::command]
fn vault_exists(state: State<'_, Arc<AppStateData>>) -> bool {
    state.db.meta("kdf_salt").is_some()
}

/// Create a new vault (first-run setup).
#[tauri::command]
fn create_vault(
    password: String,
    device_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<String, String> {
    if vault_exists(state.clone()) {
        return Err("vault already exists".into());
    }

    // Generate device identity
    let (signing_key, verifying_key) = crypto::generate_ed25519_keypair();
    let device_id = uuid::Uuid::new_v4().to_string();
    let public_key_bytes = verifying_key.to_bytes();
    let fingerprint = crypto::fingerprint_hex(&public_key_bytes);

    // Generate salt and derive keys
    let salt = crypto::generate_salt();
    let master_key = crypto::derive_master_key(&password, &salt)?;
    let db_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.db.v1");
    let file_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.file.v1");

    // Store meta
    state.db.set_meta("kdf_salt", &salt)?;
    state.db.set_meta("kdf_m_cost", &crypto::ARGON2_M_COST.to_le_bytes())?;
    state.db.set_meta("kdf_t_cost", &crypto::ARGON2_T_COST.to_le_bytes())?;
    state.db.set_meta("kdf_p_cost", &crypto::ARGON2_P_COST.to_le_bytes())?;
    state.db.set_meta("device_id", device_id.as_bytes())?;

    // Store Ed25519 private key (encrypted with DB key)
    let priv_key_bytes = signing_key.to_bytes();
    let priv_key_enc = crypto::encrypt_field(db_key.as_ref(), &priv_key_bytes)?;
    state.db.set_meta("ed25519_private", priv_key_enc.as_bytes())?;
    state.db.set_meta("ed25519_public", &public_key_bytes)?;

    // Store this device as the local identity
    let self_device = Device {
        device_id: device_id.clone(),
        display_name: device_name,
        public_key_b64: base64::engine::general_purpose::STANDARD.encode(&public_key_bytes),
        fingerprint: fingerprint.clone(),
        trusted: true,
        last_seen: now_ms(),
    };
    state.db.upsert_device(&db_key, &self_device, &public_key_bytes)?;

    // Verification value: encrypt a known string to check password later
    let verify_enc = crypto::encrypt_field(db_key.as_ref(), b"phantomlink_verify_ok")?;
    state.db.set_meta("verify", verify_enc.as_bytes())?;

    // Store keys in memory
    state.app.set_keys(master_key, db_key, file_key);
    state.app.set_initialized(true);

    Ok(device_id)
}

/// Unlock the vault with password.
#[tauri::command]
fn unlock_vault(
    password: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<bool, String> {
    // Check lockout
    {
        let lockout = state.app.lockout_until.lock().unwrap();
        if let Some(until) = *lockout {
            if std::time::Instant::now() < until {
                let secs = (until - std::time::Instant::now()).as_secs();
                return Err(format!("locked, retry in {secs}s"));
            }
        }
    }

    let salt = state
        .db
        .meta("kdf_salt")
        .ok_or_else(|| "vault not found".to_string())?;
    if salt.len() != crypto::SALT_LEN {
        return Err("corrupt salt".into());
    }
    let salt_arr: [u8; crypto::SALT_LEN] = salt[..].try_into().unwrap();

    let master_key = crypto::derive_master_key(&password, &salt_arr)?;
    let db_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.db.v1");
    let file_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.file.v1");

    // Verify password by decrypting the verify string
    let verify_enc = state.db.meta_string("verify").ok_or_else(|| "no verify".to_string())?;
    let verify_bytes = crypto::decrypt_field(db_key.as_ref(), &verify_enc)?;
    if verify_bytes != b"phantomlink_verify_ok" {
        return record_failure(state.clone());
    }

    // Success: reset failure counters
    *state.app.failed_attempts.lock().unwrap() = 0;
    *state.app.lockout_until.lock().unwrap() = None;

    state.app.set_keys(master_key, db_key, file_key);
    state.app.set_initialized(true);

    Ok(true)
}

/// Lock the vault (clear all keys from memory).
#[tauri::command]
fn lock_vault(state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.app.clear_keys();
    Ok(())
}

/// Check if vault is currently unlocked.
#[tauri::command]
fn is_unlocked(state: State<'_, Arc<AppStateData>>) -> bool {
    state.app.is_unlocked()
}

/// Get this device's ID.
#[tauri::command]
fn get_device_id(state: State<'_, Arc<AppStateData>>) -> Result<String, String> {
    state
        .db
        .meta_string("device_id")
        .ok_or_else(|| "device_id not set".into())
}

/// Get this device's display name.
#[tauri::command]
fn get_device_name(state: State<'_, Arc<AppStateData>>) -> Result<String, String> {
    let db_key = state.app.get_db_key()?;
    let did = state.db.meta_string("device_id").ok_or("no device id")?;
    let device = state
        .db
        .get_device_by_id(&db_key, &did)?
        .ok_or("device not found")?;
    Ok(device.display_name)
}

/// Get this device's pairing code and fingerprint.
#[tauri::command]
fn get_device_info(state: State<'_, Arc<AppStateData>>) -> Result<serde_json::Value, String> {
    let db_key = state.app.get_db_key()?;
    let did = state.db.meta_string("device_id").ok_or("no device id")?;
    let device = state
        .db
        .get_device_by_id(&db_key, &did)?
        .ok_or("device not found")?;
    Ok(serde_json::json!({
        "device_id": device.device_id,
        "display_name": device.display_name,
        "fingerprint": device.fingerprint,
        "pairing_code": crypto::generate_pairing_code(),
    }))
}

fn record_failure(state: State<'_, Arc<AppStateData>>) -> Result<bool, String> {
    let mut attempts = state.app.failed_attempts.lock().unwrap();
    *attempts += 1;
    let count = *attempts;
    drop(attempts);

    let delay_secs = match count {
        1..=4 => return Err("incorrect password".into()),
        5 => 30,
        6 => 60,
        7 => 300,
        _ => 900,
    };

    let mut lockout = state.app.lockout_until.lock().unwrap();
    *lockout = Some(std::time::Instant::now() + std::time::Duration::from_secs(delay_secs));
    Err(format!("too many attempts, locked for {delay_secs}s"))
}

// ---- Devices ----

#[tauri::command]
fn get_devices(state: State<'_, Arc<AppStateData>>) -> Result<Vec<Device>, String> {
    let db_key = state.app.get_db_key()?;
    state.db.get_devices(&db_key)
}

#[tauri::command]
fn get_local_ip() -> Result<Vec<String>, String> {
    Ok(network::get_local_ipv4_addrs())
}

// ---- Conversations ----

#[tauri::command]
fn get_conversations(state: State<'_, Arc<AppStateData>>) -> Result<Vec<Conversation>, String> {
    let db_key = state.app.get_db_key()?;
    state.db.get_conversations(&db_key)
}

#[tauri::command]
fn get_or_create_private_conversation(
    peer_device_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<Conversation, String> {
    let db_key = state.app.get_db_key()?;
    // Check if conversation already exists
    let convs = state.db.get_conversations(&db_key)?;
    if let Some(existing) = convs.into_iter().find(|c| c.peer_device_id.as_deref() == Some(&peer_device_id)) {
        return Ok(existing);
    }

    // Get peer device name
    let peer = state
        .db
        .get_device_by_id(&db_key, &peer_device_id)?
        .ok_or("peer device not found")?;

    let conv = Conversation {
        conv_id: uuid::Uuid::new_v4().to_string(),
        conv_type: "private".to_string(),
        peer_device_id: Some(peer_device_id),
        group_id: None,
        display_name: peer.display_name,
        last_message_at: 0,
        unread_count: 0,
        pinned: false,
        muted: false,
    };
    state.db.upsert_conversation(&db_key, &conv)?;
    Ok(conv)
}

#[tauri::command]
fn reset_unread(conv_id: String, state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.db.reset_unread(&conv_id)
}

// ---- Messages ----

#[tauri::command]
fn get_messages(
    conv_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<'_, Arc<AppStateData>>,
) -> Result<Vec<ChatMessage>, String> {
    let db_key = state.app.get_db_key()?;
    state.db.get_messages(&db_key, &conv_id, limit.unwrap_or(200), offset.unwrap_or(0))
}

#[tauri::command]
fn save_local_message(
    conv_id: String,
    msg_type: String,
    content: String,
    direction: String,
    burn_after_read: bool,
    state: State<'_, Arc<AppStateData>>,
) -> Result<ChatMessage, String> {
    let db_key = state.app.get_db_key()?;
    let device_id = state.db.meta_string("device_id").unwrap_or_default();
    let sender_id = if direction == "sent" {
        device_id.clone()
    } else {
        "unknown".to_string()
    };

    let msg = Message {
        message_id: uuid::Uuid::new_v4().to_string(),
        conv_id: conv_id.clone(),
        sender_id,
        direction,
        msg_type,
        content,
        timestamp: now_ms(),
        sequence: 0,
        status: "sent".to_string(),
        burn_after_read,
        burned: false,
        file_id: None,
        reply_to: None,
    };
    state.db.insert_message(&db_key, &msg)?;

    // Return as ChatMessage
    Ok(ChatMessage {
        message_id: msg.message_id,
        conv_id: msg.conv_id,
        sender_id: msg.sender_id,
        direction: msg.direction,
        msg_type: msg.msg_type,
        content: msg.content,
        timestamp: msg.timestamp,
        status: msg.status,
        burn_after_read: msg.burn_after_read,
        file_info: None,
        reply_to: None,
    })
}

#[tauri::command]
fn search_messages(
    query: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<Vec<ChatMessage>, String> {
    let db_key = state.app.get_db_key()?;
    state.db.search_messages(&db_key, &query, 100)
}

#[tauri::command]
fn update_message_status(
    message_id: String,
    status: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    state.db.update_message_status(&message_id, &status)
}

#[tauri::command]
fn burn_message(
    message_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    state.db.burn_message(&message_id)
}

#[tauri::command]
fn delete_message(
    message_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    state.db.delete_message(&message_id)
}

// ---- Settings ----

#[tauri::command]
fn get_setting(key: String, state: State<'_, Arc<AppStateData>>) -> Result<Option<String>, String> {
    Ok(state
        .db
        .meta_string(&format!("setting_{key}")))
}

#[tauri::command]
fn set_setting(
    key: String,
    value: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    state
        .db
        .set_meta(&format!("setting_{key}"), value.as_bytes())
}

#[tauri::command]
fn get_all_settings(state: State<'_, Arc<AppStateData>>) -> Result<serde_json::Value, String> {
    let defaults = serde_json::json!({
        "lock_timeout_minutes": 5,
        "clipboard_clear_seconds": 30,
        "blur_on_focus_loss": true,
        "lock_on_sleep": true,
        "auto_backup_enabled": true,
        "auto_backup_interval_hours": 24,
        "auto_backup_max": 7,
        "burn_after_read_delay": 10,
        "network_port": 48443,
    });

    let mut result = defaults;
    if let Some(obj) = result.as_object_mut() {
        for key in ["lock_timeout_minutes", "clipboard_clear_seconds", "blur_on_focus_loss", "lock_on_sleep", "auto_backup_enabled", "auto_backup_interval_hours", "auto_backup_max", "burn_after_read_delay", "network_port"] {
            if let Some(v) = state.db.meta_string(&format!("setting_{key}")) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v) {
                    obj.insert(key.to_string(), parsed);
                }
            }
        }
    }
    Ok(result)
}

// ---- File operations ----

#[tauri::command]
fn save_file_from_base64(
    file_name: String,
    mime_type: String,
    data_b64: String,
    message_id: Option<String>,
    state: State<'_, Arc<AppStateData>>,
) -> Result<FileRecord, String> {
    let file_key = state.app.get_file_key()?;
    let db_key = state.app.get_db_key()?;

    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("b64 decode: {e}"))?;

    let sha = file_store::FileStore::sha256_hex(&data);
    let stored_name = state.file_store.store(&file_key, &data)?;

    let is_image = mime_type.starts_with("image/");
    let file_id = uuid::Uuid::new_v4().to_string();

    let record = FileRecord {
        file_id: file_id.clone(),
        message_id: message_id.unwrap_or_default(),
        original_name: file_name,
        stored_name,
        mime_type,
        size: data.len() as i64,
        sha256: sha,
        is_image,
        width: None,
        height: None,
        created_at: now_ms(),
    };
    state.db.insert_file_record(&db_key, &record)?;
    Ok(record)
}

#[tauri::command]
fn load_file_to_base64(
    stored_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<String, String> {
    let file_key = state.app.get_file_key()?;
    let data = state.file_store.load(&file_key, &stored_name)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

// ---- Network ----

#[tauri::command]
fn start_network(
    display_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<serde_json::Value, String> {
    let db_key = state.app.get_db_key()?;
    let device_id = state.db.meta_string("device_id").ok_or("no device id")?;

    // Get our fingerprint
    let public_key = state.db.meta("ed25519_public").ok_or("no public key")?;
    let fingerprint = crypto::fingerprint_hex(&public_key);

    // Start mDNS
    state
        .network
        .start_mdns(&device_id, &display_name, &fingerprint)?;

    let local_ips = network::get_local_ipv4_addrs();
    Ok(serde_json::json!({
        "device_id": device_id,
        "fingerprint": fingerprint,
        "local_ips": local_ips,
        "port": state.network.port,
    }))
}

#[tauri::command]
fn stop_network(state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.network.stop_mdns();
    Ok(())
}

#[tauri::command]
fn connect_to_peer(
    ip: String,
    port: u16,
    device_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<bool, String> {
    // We need to use the tokio runtime from state
    let network = state.network.clone();
    state.runtime.block_on(async move {
        match network.connect_to_peer(&ip, port, device_id).await {
            Ok(_) => Ok(true),
            Err(e) => Err(e),
        }
    })
}

#[tauri::command]
fn get_connected_peers(state: State<'_, Arc<AppStateData>>) -> Vec<String> {
    state.network.connected_peers()
}

#[tauri::command]
fn send_frame_to_peer(
    device_id: String,
    frame_json: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let frame = Frame::from_json(&frame_json)?;
    let encoded = protocol::encode_frame(&frame);
    state.network.send_to_peer(&device_id, encoded)
}

// ---- Backup ----

#[tauri::command]
fn export_backup(
    password: String,
    dest_path: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<String, String> {
    let db_key = state.app.get_db_key()?;
    let file_key = state.app.get_file_key()?;

    // Create backup salt and derive backup key
    let backup_salt = crypto::generate_salt();
    let backup_key = crypto::derive_master_key(&password, &backup_salt)?;

    // Serialize all database data (plaintext JSON)
    let devices = state.db.get_devices(&db_key)?;
    let convs = state.db.get_conversations(&db_key)?;
    let groups = state.db.get_groups(&db_key)?;

    // Get all messages (up to 50000)
    let mut all_messages: Vec<serde_json::Value> = Vec::new();
    for conv in &convs {
        let msgs = state.db.get_messages(&db_key, &conv.conv_id, 50000, 0)?;
        for m in msgs {
            all_messages.push(serde_json::to_value(&m).unwrap());
        }
    }

    let snapshot = serde_json::json!({
        "devices": devices,
        "conversations": convs,
        "groups": groups,
        "messages": all_messages,
    });
    let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();

    // Encrypt snapshot
    let (ct, nonce) = crypto::encrypt(backup_key.as_ref(), &snapshot_bytes, b"backup")?;

    // Write backup file
    let mut file_data = Vec::new();
    file_data.extend_from_slice(b"PLVAULT01"); // magic
    file_data.extend_from_slice(&backup_salt);
    file_data.extend_from_slice(&nonce);
    file_data.extend_from_slice(&(ct.len() as u64).to_le_bytes());
    file_data.extend_from_slice(&ct);

    // Also collect files (simplified: just include the encrypted file directory)
    // For v1, we include text + metadata only. File attachments can be re-sent.

    std::fs::write(&dest_path, &file_data).map_err(|e| format!("write backup: {e}"))?;

    Ok(dest_path)
}

#[tauri::command]
fn import_backup(
    password: String,
    src_path: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<bool, String> {
    let data =
        std::fs::read(&src_path).map_err(|e| format!("read backup: {e}"))?;

    if data.len() < 8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8 {
        return Err("backup file too short".into());
    }

    if &data[..8] != b"PLVAULT01" {
        return Err("invalid backup format".into());
    }

    let salt: [u8; crypto::SALT_LEN] =
        data[8..8 + crypto::SALT_LEN].try_into().unwrap();
    let nonce: [u8; crypto::NONCE_LEN] =
        data[8 + crypto::SALT_LEN..8 + crypto::SALT_LEN + crypto::NONCE_LEN]
            .try_into()
            .unwrap();
    let ct_len = u64::from_le_bytes(
        data[8 + crypto::SALT_LEN + crypto::NONCE_LEN..8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8]
            .try_into()
            .unwrap(),
    ) as usize;
    let ct = &data[8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8..8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8 + ct_len];

    let backup_key = crypto::derive_master_key(&password, &salt)?;
    let snapshot_bytes =
        crypto::decrypt(backup_key.as_ref(), ct, &nonce, b"backup")?;

    let snapshot: serde_json::Value =
        serde_json::from_slice(&snapshot_bytes).map_err(|e| format!("parse snapshot: {e}"))?;

    // Restore data into current vault
    let db_key = state.app.get_db_key()?;

    // Restore devices
    if let Some(devices) = snapshot.get("devices").and_then(|v| v.as_array()) {
        for d in devices {
            if let Ok(device) = serde_json::from_value::<Device>(d.clone()) {
                let pubkey = base64::engine::general_purpose::STANDARD
                    .decode(&device.public_key_b64)
                    .unwrap_or_default();
                let _ = state.db.upsert_device(&db_key, &device, &pubkey);
            }
        }
    }

    // Restore conversations
    if let Some(convs) = snapshot.get("conversations").and_then(|v| v.as_array()) {
        for c in convs {
            if let Ok(conv) = serde_json::from_value::<Conversation>(c.clone()) {
                let _ = state.db.upsert_conversation(&db_key, &conv);
            }
        }
    }

    // Restore messages
    if let Some(messages) = snapshot.get("messages").and_then(|v| v.as_array()) {
        for m in messages {
            if let Ok(chat_msg) = serde_json::from_value::<ChatMessage>(m.clone()) {
                let msg = Message {
                    message_id: chat_msg.message_id,
                    conv_id: chat_msg.conv_id,
                    sender_id: chat_msg.sender_id,
                    direction: chat_msg.direction,
                    msg_type: chat_msg.msg_type,
                    content: chat_msg.content,
                    timestamp: chat_msg.timestamp,
                    sequence: 0,
                    status: chat_msg.status,
                    burn_after_read: chat_msg.burn_after_read,
                    burned: false,
                    file_id: chat_msg.file_info.map(|f| f.file_id),
                    reply_to: chat_msg.reply_to,
                };
                let _ = state.db.insert_message(&db_key, &msg);
            }
        }
    }

    Ok(true)
}

// ---- Utility ----

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Wrapper holding all shared application state.
pub struct AppStateData {
    pub app: state::AppState,
    pub db: Database,
    pub file_store: file_store::FileStore,
    pub network: Arc<network::NetworkManager>,
    pub runtime: Arc<tokio::runtime::Runtime>,
}

// Trait to add convenience methods for Database in command context
trait DbMetaExt {
    fn meta(&self, key: &str) -> Option<Vec<u8>>;
    fn meta_string(&self, key: &str) -> Option<String>;
}

impl DbMetaExt for Database {
    fn meta(&self, key: &str) -> Option<Vec<u8>> {
        self.get_meta(key).ok().flatten()
    }
    fn meta_string(&self, key: &str) -> Option<String> {
        self.get_meta_string(key).ok().flatten()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Determine data directory
    let data_dir = dirs_or_default();
    std::fs::create_dir_all(&data_dir).expect("create data dir");

    let db_path = data_dir.join(".pl_cache");
    let files_dir = data_dir.join(".pl_assets");

    let db = Database::open(&db_path).expect("open database");
    db.init_schema().expect("init db schema");

    let file_store = file_store::FileStore::new(&files_dir).expect("create file store");
    let network = Arc::new(network::NetworkManager::new(network::DEFAULT_PORT));
    let runtime = Arc::new(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("create tokio runtime"));

    let device_id = db
        .get_meta_string("device_id")
        .ok().flatten().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let app_state = state::AppState::new(data_dir, device_id.clone());
    // Check if vault exists
    if db.get_meta("kdf_salt").ok().flatten().is_some() {
        app_state.set_initialized(true);
    }

    let state_data = Arc::new(AppStateData {
        app: app_state,
        db,
        file_store,
        network,
        runtime,
    });

    // Start TCP listener in background
    let nm = state_data.network.clone();
    let port = state_data.network.port;
    let rt = state_data.runtime.clone();
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    rt.block_on(async {
        let _ = nm.start_listener(port, frame_tx).await;
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state_data)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = window.emit("window-blur", ());
            }
        })
        .setup(|_app| {
            // Apply window vibrancy
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    #[cfg(target_os = "macos")]
                    {
                        use window_vibrancy::apply_vibrancy;
                        use window_vibrancy::NSVisualEffectMaterial;
                        use window_vibrancy::NSVisualEffectState;
                        let _ = apply_vibrancy(
                            &window,
                            NSVisualEffectMaterial::HudWindow,
                            Some(NSVisualEffectState::Active),
                            None,
                        );
                    }
                }
            }

            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window_vibrancy::apply_acrylic(&window, None);
                    let _ = window_vibrancy::apply_mica(&window, None);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_exists,
            create_vault,
            unlock_vault,
            lock_vault,
            is_unlocked,
            get_device_id,
            get_device_name,
            get_device_info,
            get_devices,
            get_local_ip,
            get_conversations,
            get_or_create_private_conversation,
            reset_unread,
            get_messages,
            save_local_message,
            search_messages,
            update_message_status,
            burn_message,
            delete_message,
            get_setting,
            set_setting,
            get_all_settings,
            save_file_from_base64,
            load_file_to_base64,
            start_network,
            stop_network,
            connect_to_peer,
            get_connected_peers,
            send_frame_to_peer,
            export_backup,
            import_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PhantomLink");
}

fn dirs_or_default() -> std::path::PathBuf {
    if let Some(base) = std::env::var_os("HOME") {
        let p = std::path::PathBuf::from(base)
            .join("Library")
            .join("Application Support")
            .join(".pl_session_cache");
        if p.exists() || cfg!(target_os = "macos") {
            return p;
        }
    }
    // Fallback for Windows or other
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(local).join(".pl_session_cache");
    }
    // Last resort: temp
    std::env::temp_dir().join(".pl_session_cache")
}
