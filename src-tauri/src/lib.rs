//! PhantomLink application logic and Tauri command bindings.

mod crypto;
mod db;
mod file_store;
mod network;
mod protocol;
mod state;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, Emitter};
use base64::Engine as _;
use tokio::sync::mpsc;

use db::{ChatMessage, Conversation, Database, Device, FileRecord, Message};
use network::DiscoveredPeer;
use protocol::Frame;

const APP_VERSION: &str = "1.4.2";

// ---- Vault lifecycle ----

#[tauri::command]
fn vault_exists(state: State<'_, Arc<AppStateData>>) -> bool {
    state.db.meta("kdf_salt").is_some()
}

#[tauri::command]
fn create_vault(
    password: String,
    device_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<String, String> {
    if vault_exists(state.clone()) {
        return Err("vault already exists".into());
    }

    let (signing_key, verifying_key) = crypto::generate_ed25519_keypair();
    let device_id = uuid::Uuid::new_v4().to_string();
    let public_key_bytes = verifying_key.to_bytes();
    let fingerprint = crypto::fingerprint_hex(&public_key_bytes);

    let salt = crypto::generate_salt();
    let master_key = crypto::derive_master_key(&password, &salt)?;
    let db_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.db.v1");
    let file_key = crypto::hkdf_derive(master_key.as_ref(), "phantomlink.file.v1");

    state.db.set_meta("kdf_salt", &salt)?;
    state.db.set_meta("kdf_m_cost", &crypto::ARGON2_M_COST.to_le_bytes())?;
    state.db.set_meta("kdf_t_cost", &crypto::ARGON2_T_COST.to_le_bytes())?;
    state.db.set_meta("kdf_p_cost", &crypto::ARGON2_P_COST.to_le_bytes())?;
    state.db.set_meta("device_id", device_id.as_bytes())?;

    let priv_key_bytes = signing_key.to_bytes();
    let priv_key_enc = crypto::encrypt_field(db_key.as_ref(), &priv_key_bytes)?;
    state.db.set_meta("ed25519_private", priv_key_enc.as_bytes())?;
    state.db.set_meta("ed25519_public", &public_key_bytes)?;

    let self_device = Device {
        device_id: device_id.clone(),
        display_name: device_name,
        public_key_b64: base64::engine::general_purpose::STANDARD.encode(&public_key_bytes),
        fingerprint: fingerprint.clone(),
        trusted: true,
        last_seen: now_ms(),
        ip: String::new(),
        port: 0,
    };
    state.db.upsert_device(&db_key, &self_device, &public_key_bytes)?;

    let verify_enc = crypto::encrypt_field(db_key.as_ref(), b"phantomlink_verify_ok")?;
    state.db.set_meta("verify", verify_enc.as_bytes())?;

    state.app.set_keys(master_key, db_key, file_key);
    state.app.set_initialized(true);

    Ok(device_id)
}

#[tauri::command]
fn unlock_vault(
    password: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<bool, String> {
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

    let verify_enc = state.db.meta_string("verify").ok_or_else(|| "no verify".to_string())?;
    let verify_bytes = crypto::decrypt_field(db_key.as_ref(), &verify_enc)?;
    if verify_bytes != b"phantomlink_verify_ok" {
        // Check if self-destruct is enabled
        let sd_enabled = state
            .db
            .meta_string("setting_self_destruct_enabled")
            .map(|v| v == "true")
            .unwrap_or(false);
        if sd_enabled {
            let attacks = state.app.record_attack();
            if attacks >= 5 {
                let _ = perform_self_destruct(&state);
                return Err("SELF_DESTRUCT_ACTIVATED".into());
            }
        }
        return record_failure(state.clone());
    }

    *state.app.failed_attempts.lock().unwrap() = 0;
    *state.app.lockout_until.lock().unwrap() = None;
    state.app.reset_attacks();

    state.app.set_keys(master_key, db_key, file_key);
    state.app.set_initialized(true);
    state.app.set_ui_locked(false);

    Ok(true)
}

#[tauri::command]
fn lock_vault(state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    // UI-only lock: keys stay in memory so messages can still be received.
    state.app.set_ui_locked(true);
    Ok(())
}

#[tauri::command]
fn is_unlocked(state: State<'_, Arc<AppStateData>>) -> bool {
    state.app.is_unlocked()
}

#[tauri::command]
fn is_ui_locked(state: State<'_, Arc<AppStateData>>) -> bool {
    state.app.is_ui_locked()
}

#[tauri::command]
fn get_device_id(state: State<'_, Arc<AppStateData>>) -> Result<String, String> {
    state
        .db
        .meta_string("device_id")
        .ok_or_else(|| "device_id not set".into())
}

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

#[tauri::command]
fn get_app_version() -> String {
    APP_VERSION.to_string()
}

/// Save a downloaded release asset (base64) into the user's Downloads folder.
#[tauri::command]
fn save_downloaded_file(file_name: String, data_b64: String) -> Result<String, String> {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("decode download: {e}"))?;
    let dir = if let Some(home) = std::env::var_os("HOME") {
        std::path::PathBuf::from(home).join("Downloads")
    } else if let Some(local) = std::env::var_os("USERPROFILE") {
        std::path::PathBuf::from(local).join("Downloads")
    } else {
        std::env::temp_dir()
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir downloads: {e}"))?;
    let safe_name = file_name.replace(['/', '\\', '\0'], "_");
    let path = dir.join(safe_name);
    std::fs::write(&path, &data).map_err(|e| format!("write download: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn downloads_dir() -> std::path::PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        std::path::PathBuf::from(home).join("Downloads")
    } else if let Some(local) = std::env::var_os("USERPROFILE") {
        std::path::PathBuf::from(local).join("Downloads")
    } else {
        std::env::temp_dir()
    }
}

/// Query the latest GitHub release metadata.
#[tauri::command]
fn check_latest_release(state: State<'_, Arc<AppStateData>>) -> Result<serde_json::Value, String> {
    let url = "https://api.github.com/repos/0x5477/phantomlink/releases/latest";
    state.runtime.block_on(async {
        let client = reqwest::Client::builder()
            .user_agent(format!("PhantomLink/{}", APP_VERSION))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("check update: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.json::<serde_json::Value>()
            .await
            .map_err(|e| format!("parse release: {e}"))
    })
}

/// Download a GitHub release asset (follows redirects) and save it to Downloads.
#[tauri::command]
fn download_release_asset(
    url: String,
    file_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<String, String> {
    let url2 = url.clone();
    let bytes = state.runtime.block_on(async move {
        let client = reqwest::Client::builder()
            .user_agent(format!("PhantomLink/{}", APP_VERSION))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(&url2)
            .send()
            .await
            .map_err(|e| format!("download {url2}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.bytes().await.map_err(|e| format!("read body: {e}"))
    })?;

    let dir = downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir downloads: {e}"))?;
    let safe_name = file_name.replace(['/', '\\', '\0'], "_");
    let path = dir.join(safe_name);
    std::fs::write(&path, &bytes).map_err(|e| format!("write download: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
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

// ---- Self-destruct ----

fn perform_self_destruct(state: &Arc<AppStateData>) -> Result<(), String> {
    log::warn!("SELF-DESTRUCT activated: wiping all data");

    // Wipe database
    state.db.wipe_all()?;

    // Wipe file store
    if state.file_store.base_path().exists() {
        std::fs::remove_dir_all(state.file_store.base_path())
            .map_err(|e| format!("rm file store: {e}"))?;
    }

    // Clear keys
    state.app.clear_keys();

    Ok(())
}

#[tauri::command]
fn self_destruct(state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    perform_self_destruct(&state)
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

/// Manually add a friend by IP address.
#[tauri::command]
fn add_device(
    ip: String,
    port: Option<u16>,
    display_name: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<Device, String> {
    let db_key = state.app.get_db_key()?;
    let port = port.unwrap_or(network::DEFAULT_PORT);
    let device_id = uuid::Uuid::new_v4().to_string();

    let device = Device {
        device_id: device_id.clone(),
        display_name: display_name.clone(),
        public_key_b64: String::new(),
        fingerprint: String::new(),
        trusted: false,
        last_seen: now_ms(),
        ip: ip.clone(),
        port,
    };
    state.db.upsert_device(&db_key, &device, &[])?;
    state.db.set_device_address(&device_id, &ip, port)?;

    // Attempt connection and send Pair frame
    let network = state.network.clone();
    let did = device_id.clone();
    let ip_c = ip.clone();
    let connect_result = state.runtime.block_on(async {
        network.connect_to_peer(&ip_c, port, did).await
    });

    if connect_result.is_ok() {
        let our_id = state.db.meta_string("device_id").unwrap_or_default();
        let our_name = match state.db.get_device_by_id(&db_key, &our_id) {
            Ok(Some(d)) => d.display_name,
            _ => display_name.clone(),
        };
        let pubkey = state.db.meta("ed25519_public").unwrap_or_default();
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(&pubkey);
        let code = crypto::generate_pairing_code();

        let pair_frame = Frame::Pair {
            sender_id: our_id,
            display_name: our_name,
            public_key_b64: pubkey_b64,
            code,
        };
        let encoded = protocol::encode_frame(&pair_frame);
        let _ = state.network.send_to_peer(&device_id, encoded);
    } else {
        log::warn!("Could not connect to {ip}:{port}, device saved for later retry");
    }

    Ok(device)
}

/// Delete a device/contact and its conversations.
#[tauri::command]
fn delete_device(
    device_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let db_key = state.app.get_db_key()?;
    let convs = state.db.get_conversations(&db_key)?;
    for conv in &convs {
        if conv.peer_device_id.as_deref() == Some(&device_id) {
            let _ = state.db.delete_conv_messages(&conv.conv_id);
        }
    }
    state.db.delete_device(&device_id)?;
    state.network.disconnect(&device_id);
    Ok(())
}

/// Discover peers on the LAN via mDNS.
#[tauri::command]
fn discover_peers(state: State<'_, Arc<AppStateData>>) -> Result<Vec<DiscoveredPeer>, String> {
    let network = state.network.clone();
    let our_id = state.db.meta_string("device_id").unwrap_or_default();
    let peers = state.runtime.block_on(async { network.discover_peers().await })?;
    Ok(peers.into_iter().filter(|p| p.device_id != our_id).collect())
}

/// Get list of connected peer device IDs.
#[tauri::command]
fn get_connected_peers(state: State<'_, Arc<AppStateData>>) -> Vec<String> {
    state.network.connected_peers()
}

// ---- Friend requests ----

/// Send a friend request to a discovered peer by IP + port.
#[tauri::command]
fn send_friend_request(
    ip: String,
    port: Option<u16>,
    display_name_hint: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let db_key = state.app.get_db_key()?;
    let port = port.unwrap_or(network::DEFAULT_PORT);
    let our_id = state.db.meta_string("device_id").ok_or("no device id")?;
    let our_name = match state.db.get_device_by_id(&db_key, &our_id) {
        Ok(Some(d)) => d.display_name,
        _ => display_name_hint,
    };
    let pubkey = state.db.meta("ed25519_public").unwrap_or_default();
    let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(&pubkey);
    let fingerprint = crypto::fingerprint_hex(&pubkey);

    // Connect to peer
    let network = state.network.clone();
    let temp_id = format!("pending_{}", uuid::Uuid::new_v4());
    state.runtime.block_on(async {
        network.connect_to_peer(&ip, port, temp_id.clone()).await
    })?;

    // Send friend request frame
    let frame = Frame::FriendRequest {
        sender_id: our_id,
        display_name: our_name,
        public_key_b64: pubkey_b64,
        fingerprint,
    };
    state.network.send_to_peer(&temp_id, protocol::encode_frame(&frame))?;
    Ok(())
}

/// Accept a friend request: saves the requester as a device and sends a FriendResponse.
#[tauri::command]
fn accept_friend_request(
    request_id: String,
    from_device_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let db_key = state.app.get_db_key()?;

    // Get request details to build device record
    let requests = state.db.get_friend_requests(&db_key)?;
    let req = requests.iter().find(|r| r["request_id"] == request_id)
        .ok_or("friend request not found")?;

    let from_name = req["from_name"].as_str().unwrap_or("Unknown").to_string();
    let from_pubkey_b64 = req["from_public_key_b64"].as_str().unwrap_or("").to_string();
    let from_fp = req["from_fingerprint"].as_str().unwrap_or("").to_string();
    let pubkey = base64::engine::general_purpose::STANDARD.decode(&from_pubkey_b64).unwrap_or_default();

    // Save the device
    let device = Device {
        device_id: from_device_id.clone(),
        display_name: from_name.clone(),
        public_key_b64: from_pubkey_b64.clone(),
        fingerprint: from_fp.clone(),
        trusted: true,
        last_seen: now_ms(),
        ip: String::new(),
        port: 0,
    };
    state.db.upsert_device(&db_key, &device, &pubkey)?;

    // Send FriendResponse(accepted)
    let our_id = state.db.meta_string("device_id").unwrap_or_default();
    let our_pubkey = state.db.meta("ed25519_public").unwrap_or_default();
    let our_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(&our_pubkey);
    let our_fp = crypto::fingerprint_hex(&our_pubkey);
    let our_name = state.db.get_device_by_id(&db_key, &our_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();

    let resp = Frame::FriendResponse {
        responder_id: our_id,
        requester_id: from_device_id.clone(),
        accepted: true,
        display_name: our_name,
        public_key_b64: our_pubkey_b64,
        fingerprint: our_fp,
    };
    let _ = state.network.send_to_peer(&from_device_id, protocol::encode_frame(&resp));

    // Delete the friend request
    state.db.delete_friend_request(&request_id)?;

    let _ = app_handle_emit(&state, "friend-request-accepted", &serde_json::json!({"device_id": from_device_id}));
    Ok(())
}

/// Reject a friend request.
#[tauri::command]
fn reject_friend_request(
    request_id: String,
    from_device_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let our_id = state.db.meta_string("device_id").unwrap_or_default();
    let resp = Frame::FriendResponse {
        responder_id: our_id,
        requester_id: from_device_id.clone(),
        accepted: false,
        display_name: String::new(),
        public_key_b64: String::new(),
        fingerprint: String::new(),
    };
    let _ = state.network.send_to_peer(&from_device_id, protocol::encode_frame(&resp));
    state.db.delete_friend_request(&request_id)?;
    Ok(())
}

/// Get all pending friend requests.
#[tauri::command]
fn get_friend_requests(state: State<'_, Arc<AppStateData>>) -> Result<Vec<serde_json::Value>, String> {
    let db_key = state.app.get_db_key()?;
    state.db.get_friend_requests(&db_key)
}

// ---- Profile ----

/// Update profile (display name and/or avatar).
#[tauri::command]
fn update_profile(
    display_name: Option<String>,
    avatar_b64: Option<String>,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let db_key = state.app.get_db_key()?;
    let did = state.db.meta_string("device_id").ok_or("no device id")?;

    if let Some(name) = &display_name {
        state.db.update_device_name(&db_key, &did, name)?;
    }
    if let Some(avatar) = &avatar_b64 {
        state.db.set_avatar(&did, avatar)?;
    }

    // Notify all connected peers about the name change
    let our_id = did.clone();
    let name = display_name.unwrap_or_default();
    if !name.is_empty() {
        let frame = Frame::ProfileUpdate { sender_id: our_id, display_name: name };
        let encoded = protocol::encode_frame(&frame);
        for peer_id in state.network.connected_peers() {
            let _ = state.network.send_to_peer(&peer_id, encoded.clone());
        }
    }

    Ok(())
}

/// Get avatar for a device.
#[tauri::command]
fn get_avatar(device_id: String, state: State<'_, Arc<AppStateData>>) -> Result<Option<String>, String> {
    state.db.get_avatar(&device_id)
}

/// Send a voice data frame to a peer.
#[tauri::command]
fn send_voice_frame(
    peer_device_id: String,
    room_id: String,
    sequence: i64,
    audio_data: String,
    sample_rate: i64,
    channels: i64,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::VoiceData {
        sender_id,
        room_id,
        sequence,
        audio_data,
        sample_rate,
        channels,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Send a voice call invite to a peer.
#[tauri::command]
fn send_voice_call_invite(
    peer_device_id: String,
    room_id: String,
    call_type: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let db_key = state.app.get_db_key()?;
    let sender_name = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();
    let frame = Frame::VoiceCallInvite {
        sender_id,
        sender_name,
        room_id,
        call_type,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Send a voice call response to a peer.
#[tauri::command]
fn send_voice_call_response(
    peer_device_id: String,
    room_id: String,
    accepted: bool,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let responder_id = state.db.meta_string("device_id").unwrap_or_default();
    let db_key = state.app.get_db_key()?;
    let responder_name = state.db.get_device_by_id(&db_key, &responder_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();
    let frame = Frame::VoiceCallResponse {
        responder_id,
        responder_name,
        room_id,
        accepted,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Send a voice call end notification.
#[tauri::command]
fn send_voice_call_end(
    peer_device_id: String,
    room_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::VoiceCallEnd { sender_id, room_id };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Host creates an active call room locally (participants join via VoiceCallJoin).
#[tauri::command]
fn voice_call_start_room(
    room_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let db_key = state.app.get_db_key()?;
    let sender_name = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();
    let mut rooms = state.call_rooms.lock().unwrap();
    let room = rooms.entry(room_id.clone()).or_insert_with(|| CallRoom {
        host_id: sender_id.clone(),
        participants: HashMap::new(),
    });
    room.participants.insert(sender_id, sender_name);
    Ok(())
}

/// Join an active call room as a participant (send join to the room host).
#[tauri::command]
fn voice_call_join(
    host_device_id: String,
    room_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &host_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let db_key = state.app.get_db_key()?;
    let sender_name = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();
    let frame = Frame::VoiceCallJoin { sender_id, sender_name, room_id };
    state.network.send_to_peer(&host_device_id, protocol::encode_frame(&frame))
}

/// Leave an active call room (send leave to the room host).
#[tauri::command]
fn voice_call_leave(
    host_device_id: String,
    room_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &host_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::VoiceCallLeave { sender_id, room_id };
    state.network.send_to_peer(&host_device_id, protocol::encode_frame(&frame))
}

/// Host ends an entire call room: notify every participant and clear the room.
#[tauri::command]
fn voice_call_end_room(
    room_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::VoiceCallEnd { sender_id: sender_id.clone(), room_id: room_id.clone() };
    let encoded = protocol::encode_frame(&frame);
    let rooms = state.call_rooms.lock().unwrap();
    if let Some(room) = rooms.get(&room_id) {
        for pid in room.participants.keys() {
            if pid != &sender_id {
                let _ = state.network.send_to_peer(pid, encoded.clone());
            }
        }
    }
    drop(rooms);
    state.call_rooms.lock().unwrap().remove(&room_id);
    Ok(())
}

/// Send a dedicated voice message frame carrying encoded audio.
#[tauri::command]
fn send_voice_message_frame(
    peer_device_id: String,
    message_id: String,
    duration_secs: i64,
    mime: String,
    audio_b64: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::VoiceMessage {
        message_id,
        sender_id,
        recipient_id: peer_device_id.clone(),
        timestamp: now_ms(),
        duration_secs,
        mime,
        audio_b64,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Send a sticker message frame.
#[tauri::command]
fn send_sticker_frame(
    peer_device_id: String,
    message_id: String,
    sticker_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let frame = Frame::Message {
        message_id,
        sender_id,
        recipient_id: peer_device_id.clone(),
        sequence: 0,
        timestamp: now_ms(),
        msg_type: "sticker".to_string(),
        encrypted_payload: base64::engine::general_purpose::STANDARD.encode(sticker_id.as_bytes()),
        nonce: String::new(),
        flags: vec![],
        reply_to: None,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&frame))
}

/// Helper: emit an event without requiring AppHandle in the function signature.
fn app_handle_emit(_state: &Arc<AppStateData>, _event: &str, _payload: &serde_json::Value) -> Result<(), String> {
    // Events are emitted via app_handle in the frame consumer.
    // This is a no-op placeholder; real emission happens in frame consumer.
    Ok(())
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
    let convs = state.db.get_conversations(&db_key)?;
    if let Some(existing) = convs.into_iter().find(|c| c.peer_device_id.as_deref() == Some(&peer_device_id)) {
        return Ok(existing);
    }

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
    file_id: Option<String>,
    state: State<'_, Arc<AppStateData>>,
) -> Result<ChatMessage, String> {
    let db_key = state.app.get_db_key()?;
    let device_id = state.db.meta_string("device_id").unwrap_or_default();
    let sender_id = if direction == "sent" { device_id } else { "unknown".to_string() };

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
        file_id: file_id.clone(),
        reply_to: None,
    };
    state.db.insert_message(&db_key, &msg)?;

    let file_info = if let Some(ref fid) = file_id {
        state.db.get_file_record(&db_key, fid).ok().flatten()
    } else {
        None
    };

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
        file_info,
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
fn burn_message(message_id: String, state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.db.burn_message(&message_id)
}

#[tauri::command]
fn delete_message(message_id: String, state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.db.delete_message(&message_id)
}

// ---- Settings ----

#[tauri::command]
fn get_setting(key: String, state: State<'_, Arc<AppStateData>>) -> Result<Option<String>, String> {
    Ok(state.db.meta_string(&format!("setting_{key}")))
}

#[tauri::command]
fn set_setting(key: String, value: String, state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    state.db.set_meta(&format!("setting_{key}"), value.as_bytes())
}

#[tauri::command]
fn get_all_settings(state: State<'_, Arc<AppStateData>>) -> Result<serde_json::Value, String> {
    let defaults = serde_json::json!({
        "lock_timeout_minutes": 15,
        "clipboard_clear_seconds": 30,
        "blur_on_focus_loss": false,
        "lock_on_sleep": true,
        "auto_backup_enabled": true,
        "auto_backup_interval_hours": 24,
        "auto_backup_max": 7,
        "burn_after_read_delay": 10,
        "network_port": 48443,
        "self_destruct_enabled": false,
        "theme": "dark",
        "pet_enabled": true,
        "pet_x": "-1",
        "pet_y": "-1",
    });

    let mut result = defaults;
    if let Some(obj) = result.as_object_mut() {
        for key in ["lock_timeout_minutes", "clipboard_clear_seconds", "blur_on_focus_loss", "lock_on_sleep", "auto_backup_enabled", "auto_backup_interval_hours", "auto_backup_max", "burn_after_read_delay", "network_port", "self_destruct_enabled", "theme", "pet_enabled", "pet_x", "pet_y"] {
            if let Some(v) = state.db.meta_string(&format!("setting_{key}")) {
                // String settings (theme) are stored as plain strings, not JSON.
                if key == "theme" || key == "pet_x" || key == "pet_y" {
                    if !v.is_empty() { obj.insert(key.to_string(), serde_json::json!(v)); }
                    continue;
                }
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
fn load_file_to_base64(stored_name: String, state: State<'_, Arc<AppStateData>>) -> Result<String, String> {
    let file_key = state.app.get_file_key()?;
    let data = state.file_store.load(&file_key, &stored_name)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

// ---- Network ----

#[tauri::command]
fn start_network(display_name: String, state: State<'_, Arc<AppStateData>>) -> Result<serde_json::Value, String> {
    let device_id = state.db.meta_string("device_id").ok_or("no device id")?;
    let public_key = state.db.meta("ed25519_public").ok_or("no public key")?;
    let fingerprint = crypto::fingerprint_hex(&public_key);

    state.network.start_mdns(&device_id, &display_name, &fingerprint)?;
    state.network.set_self_id(&device_id);

    let local_ips = network::get_local_ipv4_addrs();

    // Auto-reconnect to known devices
    let db_key = state.app.get_db_key()?;
    if let Ok(devices) = state.db.get_devices(&db_key) {
        let our_id = state.db.meta_string("device_id").unwrap_or_default();
        let nm = state.network.clone();
        let rt = state.runtime.clone();
        for dev in &devices {
            if dev.device_id != our_id && !dev.ip.is_empty() && dev.port > 0 {
                let ip = dev.ip.clone();
                    let port = dev.port;
                let did = dev.device_id.clone();
                let nm2 = nm.clone();
                rt.spawn(async move {
                    let _ = nm2.connect_to_peer(&ip, port, did).await;
                });
            }
        }
    }

    // Identity handshake for every connection we already have.
    state.network.send_presence();

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
fn connect_to_peer(ip: String, port: u16, device_id: String, state: State<'_, Arc<AppStateData>>) -> Result<bool, String> {
    let network = state.network.clone();
    state.runtime.block_on(async {
        match network.connect_to_peer(&ip, port, device_id).await {
            Ok(_) => Ok(true),
            Err(e) => Err(e),
        }
    })
}

#[tauri::command]
fn send_frame_to_peer(device_id: String, frame_json: String, state: State<'_, Arc<AppStateData>>) -> Result<(), String> {
    ensure_peer_connected(&state, &device_id)?;
    let frame = Frame::from_json(&frame_json)?;
    let encoded = protocol::encode_frame(&frame);
    state.network.send_to_peer(&device_id, encoded)
}

#[tauri::command]
fn send_message_frame(
    peer_device_id: String, message_id: String, msg_type: String,
    content: String, burn_after_read: bool,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let sender_id = state.db.meta_string("device_id").unwrap_or_default();
    let timestamp = now_ms();
    let payload_b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 12]);

    let frame = Frame::Message {
        message_id, sender_id, recipient_id: peer_device_id.clone(),
        sequence: 0, timestamp, msg_type,
        encrypted_payload: payload_b64, nonce: nonce_b64,
        flags: if burn_after_read { vec!["burn_after_read".to_string()] } else { vec![] },
        reply_to: None,
    };
    let encoded = protocol::encode_frame(&frame);
    state.network.send_to_peer(&peer_device_id, encoded)
}

#[tauri::command]
fn send_file_frame(
    peer_device_id: String, message_id: String, file_id: String,
    state: State<'_, Arc<AppStateData>>,
) -> Result<(), String> {
    ensure_peer_connected(&state, &peer_device_id)?;
    let file_key = state.app.get_file_key()?;
    let db_key = state.app.get_db_key()?;
    let file_rec = state.db.get_file_record(&db_key, &file_id)?.ok_or("file not found")?;
    let file_data = state.file_store.load(&file_key, &file_rec.stored_name)?;

    let chunk_size: usize = 262144;
    let total_chunks = ((file_data.len() + chunk_size - 1) / chunk_size) as i64;

    let meta_frame = Frame::FileMeta {
        file_id: file_id.clone(), message_id: message_id.clone(),
        name: file_rec.original_name.clone(), size: file_rec.size,
        mime: file_rec.mime_type.clone(), sha256: file_rec.sha256.clone(),
        total_chunks, chunk_size: chunk_size as i64, is_image: file_rec.is_image,
        thumbnail_b64: None, width: file_rec.width, height: file_rec.height,
    };
    state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&meta_frame))?;

    for i in 0..total_chunks {
        let start = (i as usize) * chunk_size;
        let end = std::cmp::min(start + chunk_size, file_data.len());
        let chunk = &file_data[start..end];
        let chunk_b64 = base64::engine::general_purpose::STANDARD.encode(chunk);

        let chunk_frame = Frame::FileChunk {
            file_id: file_id.clone(), chunk_index: i,
            encrypted_data: chunk_b64, is_last: i == total_chunks - 1,
        };
        state.network.send_to_peer(&peer_device_id, protocol::encode_frame(&chunk_frame))?;
    }
    Ok(())
}

// ---- Backup ----

#[tauri::command]
fn export_backup(password: String, dest_path: String, state: State<'_, Arc<AppStateData>>) -> Result<String, String> {
    let db_key = state.app.get_db_key()?;
    let backup_salt = crypto::generate_salt();
    let backup_key = crypto::derive_master_key(&password, &backup_salt)?;

    let devices = state.db.get_devices(&db_key)?;
    let convs = state.db.get_conversations(&db_key)?;
    let groups = state.db.get_groups(&db_key)?;

    let mut all_messages: Vec<serde_json::Value> = Vec::new();
    for conv in &convs {
        let msgs = state.db.get_messages(&db_key, &conv.conv_id, 50000, 0)?;
        for m in msgs { all_messages.push(serde_json::to_value(&m).unwrap()); }
    }

    let snapshot = serde_json::json!({ "devices": devices, "conversations": convs, "groups": groups, "messages": all_messages });
    let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
    let (ct, nonce) = crypto::encrypt(backup_key.as_ref(), &snapshot_bytes, b"backup")?;

    let mut file_data = Vec::new();
    file_data.extend_from_slice(b"PLVAULT01");
    file_data.extend_from_slice(&backup_salt);
    file_data.extend_from_slice(&nonce);
    file_data.extend_from_slice(&(ct.len() as u64).to_le_bytes());
    file_data.extend_from_slice(&ct);
    std::fs::write(&dest_path, &file_data).map_err(|e| format!("write backup: {e}"))?;
    Ok(dest_path)
}

#[tauri::command]
fn import_backup(password: String, src_path: String, state: State<'_, Arc<AppStateData>>) -> Result<bool, String> {
    let data = std::fs::read(&src_path).map_err(|e| format!("read backup: {e}"))?;
    if data.len() < 8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8 { return Err("backup file too short".into()); }
    if &data[..8] != b"PLVAULT01" { return Err("invalid backup format".into()); }

    let salt: [u8; crypto::SALT_LEN] = data[8..8 + crypto::SALT_LEN].try_into().unwrap();
    let nonce: [u8; crypto::NONCE_LEN] = data[8 + crypto::SALT_LEN..8 + crypto::SALT_LEN + crypto::NONCE_LEN].try_into().unwrap();
    let ct_len = u64::from_le_bytes(data[8 + crypto::SALT_LEN + crypto::NONCE_LEN..8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8].try_into().unwrap()) as usize;
    let ct = &data[8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8..8 + crypto::SALT_LEN + crypto::NONCE_LEN + 8 + ct_len];

    let backup_key = crypto::derive_master_key(&password, &salt)?;
    let snapshot_bytes = crypto::decrypt(backup_key.as_ref(), ct, &nonce, b"backup")?;
    let snapshot: serde_json::Value = serde_json::from_slice(&snapshot_bytes).map_err(|e| format!("parse snapshot: {e}"))?;

    let db_key = state.app.get_db_key()?;

    if let Some(devices) = snapshot.get("devices").and_then(|v| v.as_array()) {
        for d in devices {
            if let Ok(device) = serde_json::from_value::<serde_json::Value>(d.clone()) {
                let did = device.get("device_id").and_then(|v| v.as_str()).unwrap_or("");
                let dname = device.get("display_name").and_then(|v| v.as_str()).unwrap_or("");
                let pubkey_b64 = device.get("public_key_b64").and_then(|v| v.as_str()).unwrap_or("");
                let fp = device.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("");
                let pubkey = base64::engine::general_purpose::STANDARD.decode(pubkey_b64).unwrap_or_default();
                let dev = Device {
                    device_id: did.to_string(), display_name: dname.to_string(),
                    public_key_b64: pubkey_b64.to_string(), fingerprint: fp.to_string(),
                    trusted: true, last_seen: now_ms(), ip: String::new(), port: 0,
                };
                let _ = state.db.upsert_device(&db_key, &dev, &pubkey);
            }
        }
    }
    if let Some(convs) = snapshot.get("conversations").and_then(|v| v.as_array()) {
        for c in convs {
            if let Ok(conv) = serde_json::from_value::<Conversation>(c.clone()) {
                let _ = state.db.upsert_conversation(&db_key, &conv);
            }
        }
    }
    if let Some(messages) = snapshot.get("messages").and_then(|v| v.as_array()) {
        for m in messages {
            if let Ok(chat_msg) = serde_json::from_value::<ChatMessage>(m.clone()) {
                let msg = Message {
                    message_id: chat_msg.message_id, conv_id: chat_msg.conv_id,
                    sender_id: chat_msg.sender_id, direction: chat_msg.direction,
                    msg_type: chat_msg.msg_type, content: chat_msg.content,
                    timestamp: chat_msg.timestamp, sequence: 0, status: chat_msg.status,
                    burn_after_read: chat_msg.burn_after_read, burned: false,
                    file_id: chat_msg.file_info.map(|f| f.file_id), reply_to: chat_msg.reply_to,
                };
                let _ = state.db.insert_message(&db_key, &msg);
            }
        }
    }
    Ok(true)
}

// ---- Utility ----

/// Extract the sender device id from a frame, if it carries one.
fn frame_sender_id(frame: &Frame) -> Option<String> {
    match frame {
        Frame::Message { sender_id, .. }
        | Frame::KeyExchange { sender_id, .. }
        | Frame::Presence { sender_id, .. }
        | Frame::Pair { sender_id, .. }
        | Frame::FriendRequest { sender_id, .. }
        | Frame::VoiceCallInvite { sender_id, .. }
        | Frame::VoiceCallEnd { sender_id, .. }
        | Frame::VoiceData { sender_id, .. }
        | Frame::VoiceCallJoin { sender_id, .. }
        | Frame::VoiceCallLeave { sender_id, .. }
        | Frame::VoiceMessage { sender_id, .. }
        | Frame::ProfileUpdate { sender_id, .. } => Some(sender_id.clone()),
        Frame::FriendResponse { responder_id, .. } => Some(responder_id.clone()),
        Frame::VoiceCallResponse { responder_id, .. } => Some(responder_id.clone()),
        _ => None,
    }
}

/// Ensure we have a usable connection to a peer before sending.
/// If no connection exists yet, dial them using the last known IP/port so
/// that either side of a P2P pair can always initiate traffic.
fn ensure_peer_connected(state: &Arc<AppStateData>, peer_device_id: &str) -> Result<(), String> {
    if state.network.is_connected(peer_device_id) {
        return Ok(());
    }
    let db_key = state.app.get_db_key()?;
    if let Some(dev) = state.db.get_device_by_id(&db_key, peer_device_id)? {
        if !dev.ip.is_empty() && dev.port > 0 {
            let nm = state.network.clone();
            let ip = dev.ip.clone();
            let port = dev.port;
            let did = dev.device_id.clone();
            state.runtime.block_on(async move {
                nm.connect_to_peer(&ip, port, did).await
            })?;
            if state.network.is_connected(peer_device_id) {
                return Ok(());
            }
        }
    }
    Err(format!("no connection to {peer_device_id}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct CallRoom {
    pub host_id: String,
    pub participants: HashMap<String, String>, // device_id -> display_name
}

pub struct AppStateData {
    pub app: state::AppState,
    pub db: Database,
    pub file_store: file_store::FileStore,
    pub network: Arc<network::NetworkManager>,
    pub runtime: Arc<tokio::runtime::Runtime>,
    pub call_rooms: Arc<Mutex<HashMap<String, CallRoom>>>,
}

trait DbMetaExt {
    fn meta(&self, key: &str) -> Option<Vec<u8>>;
    fn meta_string(&self, key: &str) -> Option<String>;
}

impl DbMetaExt for Database {
    fn meta(&self, key: &str) -> Option<Vec<u8>> { self.get_meta(key).ok().flatten() }
    fn meta_string(&self, key: &str) -> Option<String> { self.get_meta_string(key).ok().flatten() }
}

// ---- Frame consumer ----

struct IncomingFile {
    file_id: String, message_id: String, name: String, mime: String,
    size: i64, sha256: String, is_image: bool, width: Option<i64>, height: Option<i64>,
    total_chunks: i64, received_data: Vec<u8>,
}

fn spawn_frame_consumer(
    mut frame_rx: mpsc::UnboundedReceiver<(String, Vec<u8>)>,
    state: Arc<AppStateData>,
    app_handle: tauri::AppHandle,
) {
    let rt = state.runtime.clone();
    rt.spawn(async move {
        let incoming_files: Arc<Mutex<std::collections::HashMap<String, IncomingFile>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));

        while let Some((source, frame_bytes)) = frame_rx.recv().await {
            // Process frames as long as we have keys (even if UI is locked)
            if !state.app.is_unlocked() {
                continue;
            }

            let frame_str = match String::from_utf8(frame_bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let frame = match Frame::from_json(&frame_str) {
                Ok(f) => f,
                Err(e) => { log::debug!("Failed to parse frame from {source}: {e}"); continue; }
            };

            // Critical for bidirectional P2P: remember which connection a peer
            // speaks on, so replies/outgoing frames can be routed back even if
            // we only ever received an inbound connection from them.
            if let Some(sender_id) = frame_sender_id(&frame) {
                state.network.register_alias(&sender_id, &source);
            }

            match frame {
                Frame::Pair { sender_id, display_name, public_key_b64, .. } => {
                    let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                    let pubkey = base64::engine::general_purpose::STANDARD.decode(&public_key_b64).unwrap_or_default();
                    let fingerprint = if !pubkey.is_empty() { crypto::fingerprint_hex(&pubkey) } else { String::new() };

                    let device = Device {
                        device_id: sender_id.clone(), display_name: display_name.clone(),
                        public_key_b64: public_key_b64.clone(), fingerprint: fingerprint.clone(),
                        trusted: true, last_seen: now_ms(), ip: String::new(), port: 0,
                    };
                    let _ = state.db.upsert_device(&db_key, &device, &pubkey);
                    state.network.register_alias(&sender_id, &source);

                    let our_id = state.db.meta_string("device_id").unwrap_or_default();
                    if our_id != sender_id {
                        let our_pubkey = state.db.meta("ed25519_public").unwrap_or_default();
                        let our_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(&our_pubkey);
                        let our_name = state.db.get_device_by_id(&db_key, &our_id).ok().flatten().map(|d| d.display_name).unwrap_or_default();
                        let resp = Frame::Pair { sender_id: our_id, display_name: our_name, public_key_b64: our_pubkey_b64, code: String::new() };
                        let _ = state.network.send_to_peer(&sender_id, protocol::encode_frame(&resp));
                    }
                    let _ = app_handle.emit("device-added", &device);
                }

                Frame::Message { message_id, sender_id, msg_type, encrypted_payload, flags, timestamp, .. } => {
                    let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                    let content = match base64::engine::general_purpose::STANDARD.decode(&encrypted_payload) {
                        Ok(d) => String::from_utf8_lossy(&d).to_string(),
                        Err(_) => continue,
                    };
                    let burn = flags.iter().any(|f| f == "burn_after_read");

                    let convs = match state.db.get_conversations(&db_key) { Ok(c) => c, Err(_) => continue };
                    let conv = if let Some(existing) = convs.iter().find(|c| c.peer_device_id.as_deref() == Some(&sender_id)) {
                        existing.clone()
                    } else {
                        let peer = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten();
                        let display_name = peer.map(|p| p.display_name).unwrap_or_else(|| sender_id[..8.min(sender_id.len())].to_string());
                        let new_conv = Conversation {
                            conv_id: uuid::Uuid::new_v4().to_string(), conv_type: "private".to_string(),
                            peer_device_id: Some(sender_id.clone()), group_id: None,
                            display_name, last_message_at: 0, unread_count: 0, pinned: false, muted: false,
                        };
                        let _ = state.db.upsert_conversation(&db_key, &new_conv);
                        new_conv
                    };

                    let msg = Message {
                        message_id: message_id.clone(), conv_id: conv.conv_id.clone(),
                        sender_id: sender_id.clone(), direction: "received".to_string(),
                        msg_type: msg_type.clone(), content,
                        timestamp: if timestamp > 0 { timestamp } else { now_ms() },
                        sequence: 0, status: "delivered".to_string(),
                        burn_after_read: burn, burned: false, file_id: None, reply_to: None,
                    };
                    let _ = state.db.insert_message(&db_key, &msg);
                    let _ = state.network.send_to_peer(&sender_id, protocol::encode_frame(&Frame::Ack { message_id: message_id.clone(), ack_type: "delivered".to_string() }));
                    let _ = app_handle.emit("message-received", serde_json::json!({ "conversation_id": conv.conv_id }));
                }

                Frame::FileMeta { file_id, message_id, name, size, mime, sha256, total_chunks, is_image, width, height, .. } => {
                    let mut files = incoming_files.lock().unwrap();
                    files.insert(file_id.clone(), IncomingFile {
                        file_id, message_id, name, mime, size, sha256, is_image, width, height, total_chunks, received_data: Vec::new(),
                    });
                }

                Frame::FileChunk { file_id, chunk_index, encrypted_data, is_last } => {
                    let complete = {
                        let mut files = incoming_files.lock().unwrap();
                        if let Some(ifile) = files.get_mut(&file_id) {
                            if let Ok(data) = base64::engine::general_purpose::STANDARD.decode(&encrypted_data) {
                                ifile.received_data.extend_from_slice(&data);
                            }
                            is_last || chunk_index == ifile.total_chunks - 1
                        } else { false }
                    };
                    if complete {
                        let ifile = incoming_files.lock().unwrap().remove(&file_id);
                        if let Some(ifile) = ifile {
                            let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                            let file_key = match state.app.get_file_key() { Ok(k) => k, Err(_) => continue };
                            let stored_name = match state.file_store.store(&file_key, &ifile.received_data) { Ok(n) => n, Err(e) => { log::error!("store incoming file: {e}"); continue } };
                            let new_file_id = uuid::Uuid::new_v4().to_string();
                            let record = FileRecord {
                                file_id: new_file_id.clone(), message_id: ifile.message_id.clone(),
                                original_name: ifile.name.clone(), stored_name, mime_type: ifile.mime.clone(),
                                size: ifile.size, sha256: ifile.sha256.clone(), is_image: ifile.is_image,
                                width: ifile.width, height: ifile.height, created_at: now_ms(),
                            };
                            let _ = state.db.insert_file_record(&db_key, &record);
                            let _ = state.db.update_message_file_id(&ifile.message_id, &new_file_id);
                            let _ = app_handle.emit("file-received", serde_json::json!({ "message_id": ifile.message_id, "file_id": new_file_id }));
                        }
                    }
                }

                Frame::Ack { message_id, ack_type } => {
                    let _ = state.db.update_message_status(&message_id, &ack_type);
                    let _ = app_handle.emit("message-ack", serde_json::json!({ "message_id": message_id, "status": ack_type }));
                }

               Frame::Presence { sender_id, status } => {
                   let _ = state.db.update_device_last_seen(&sender_id, now_ms());
                   let _ = app_handle.emit("peer-presence", serde_json::json!({ "device_id": sender_id, "status": status }));
               }

                Frame::FriendRequest { sender_id, display_name, public_key_b64, fingerprint } => {
                    let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                    // Check if already friends
                    let existing = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten();
                    if existing.is_some() {
                        // Already friends, auto-accept
                        let our_id = state.db.meta_string("device_id").unwrap_or_default();
                        let our_pubkey = state.db.meta("ed25519_public").unwrap_or_default();
                        let our_pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(&our_pubkey);
                        let our_fp = crypto::fingerprint_hex(&our_pubkey);
                        let resp = Frame::FriendResponse {
                            responder_id: our_id, requester_id: sender_id.clone(), accepted: true,
                            display_name: String::new(), public_key_b64: our_pubkey_b64, fingerprint: our_fp,
                        };
                        let _ = state.network.send_to_peer(&sender_id, protocol::encode_frame(&resp));
                        continue;
                    }
                    // Store the friend request
                    let request_id = uuid::Uuid::new_v4().to_string();
                    let pubkey = base64::engine::general_purpose::STANDARD.decode(&public_key_b64).unwrap_or_default();
                    let _ = state.db.insert_friend_request(&db_key, &request_id, &sender_id, &display_name, &pubkey, &fingerprint);
                    // Register the connection alias so we can respond later
                    state.network.register_alias(&sender_id, &source);
                    let _ = app_handle.emit("friend-request-received", serde_json::json!({
                        "request_id": request_id, "from_device_id": sender_id, "from_name": display_name, "fingerprint": fingerprint
                    }));
                }

                Frame::FriendResponse { responder_id, accepted, display_name, public_key_b64, fingerprint, .. } => {
                    if accepted {
                        let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                        let pubkey = base64::engine::general_purpose::STANDARD.decode(&public_key_b64).unwrap_or_default();
                        let device = Device {
                            device_id: responder_id.clone(), display_name: display_name.clone(),
                            public_key_b64: public_key_b64.clone(), fingerprint: fingerprint.clone(),
                            trusted: true, last_seen: now_ms(), ip: String::new(), port: 0,
                        };
                        let _ = state.db.upsert_device(&db_key, &device, &pubkey);
                        let _ = app_handle.emit("device-added", &device);
                        let _ = app_handle.emit("friend-request-accepted", serde_json::json!({ "device_id": responder_id }));
                    } else {
                        let _ = app_handle.emit("friend-request-rejected", serde_json::json!({ "device_id": responder_id }));
                    }
                }

                Frame::VoiceCallInvite { sender_id, sender_name, room_id, call_type } => {
                    let _ = app_handle.emit("voice-call-invite", serde_json::json!({
                        "sender_id": sender_id, "sender_name": sender_name, "room_id": room_id, "call_type": call_type
                    }));
                }

                Frame::VoiceCallResponse { responder_id, responder_name, room_id, accepted } => {
                    let _ = app_handle.emit("voice-call-response", serde_json::json!({
                        "responder_id": responder_id, "responder_name": responder_name, "room_id": room_id, "accepted": accepted
                    }));
                }

                Frame::VoiceCallEnd { sender_id, room_id } => {
                    let _ = app_handle.emit("voice-call-end", serde_json::json!({ "sender_id": sender_id, "room_id": room_id }));
                }

                Frame::VoiceCallJoin { sender_id, sender_name, room_id } => {
                    let local_id = state.db.meta_string("device_id").unwrap_or_default();
                    let mut rooms = state.call_rooms.lock().unwrap();
                    let room = rooms.entry(room_id.clone()).or_insert_with(|| CallRoom {
                        host_id: local_id.clone(),
                        participants: HashMap::new(),
                    });
                    room.participants.insert(sender_id.clone(), sender_name.clone());
                    let participants: Vec<String> = room.participants.keys().cloned().collect();
                    let names: Vec<String> = room.participants.values().cloned().collect();
                    drop(rooms);
                    // Sync the full participant list to everyone in the room.
                    let sync = Frame::VoiceCallParticipants {
                        room_id: room_id.clone(),
                        participants: participants.clone(),
                        names: names.clone(),
                    };
                    let encoded = protocol::encode_frame(&sync);
                    for pid in &participants {
                        if pid != &local_id {
                            let _ = state.network.send_to_peer(pid, encoded.clone());
                        }
                    }
                    let _ = app_handle.emit("voice-call-participants", serde_json::json!({
                        "room_id": room_id, "participants": participants, "names": names
                    }));
                }

                Frame::VoiceCallLeave { sender_id, room_id } => {
                    let mut rooms = state.call_rooms.lock().unwrap();
                    let room_empty = {
                        if let Some(room) = rooms.get_mut(&room_id) {
                            room.participants.remove(&sender_id);
                            let participants: Vec<String> = room.participants.keys().cloned().collect();
                            let names: Vec<String> = room.participants.values().cloned().collect();
                            let sync = Frame::VoiceCallParticipants {
                                room_id: room_id.clone(),
                                participants: participants.clone(),
                                names: names.clone(),
                            };
                            let encoded = protocol::encode_frame(&sync);
                            for pid in &participants {
                                let _ = state.network.send_to_peer(pid, encoded.clone());
                            }
                            let _ = app_handle.emit("voice-call-participants", serde_json::json!({
                                "room_id": room_id, "participants": participants, "names": names
                            }));
                            room.participants.is_empty()
                        } else { false }
                    };
                    if room_empty { rooms.remove(&room_id); }
                }

                Frame::VoiceCallParticipants { room_id, participants, names } => {
                    let _ = app_handle.emit("voice-call-participants", serde_json::json!({
                        "room_id": room_id, "participants": participants, "names": names
                    }));
                }

                Frame::VoiceData { sender_id, room_id, sequence, audio_data, sample_rate, channels } => {
                    let local_id = state.db.meta_string("device_id").unwrap_or_default();
                    // Host-relay: the room host receives voice data from every
                    // participant and forwards it to all other members, while
                    // emitting it locally for its own UI.
                    let rooms = state.call_rooms.lock().unwrap();
                    if let Some(room) = rooms.get(&room_id) {
                        if sender_id != local_id {
                            let _ = app_handle.emit("voice-data", serde_json::json!({
                                "sender_id": sender_id.clone(), "room_id": room_id.clone(), "sequence": sequence,
                                "audio_data": audio_data.clone(), "sample_rate": sample_rate, "channels": channels
                            }));
                        }
                        let fwd = Frame::VoiceData {
                            sender_id: sender_id.clone(),
                            room_id: room_id.clone(),
                            sequence,
                            audio_data: audio_data.clone(),
                            sample_rate,
                            channels,
                        };
                        let encoded = protocol::encode_frame(&fwd);
                        for pid in room.participants.keys() {
                            if pid != &sender_id && pid != &local_id {
                                let _ = state.network.send_to_peer(pid, encoded.clone());
                            }
                        }
                    } else if sender_id != local_id {
                        // Room not found on this device (e.g. participant receiving
                        // direct audio): just play it locally.
                        let _ = app_handle.emit("voice-data", serde_json::json!({
                            "sender_id": sender_id.clone(), "room_id": room_id.clone(), "sequence": sequence,
                            "audio_data": audio_data.clone(), "sample_rate": sample_rate, "channels": channels
                        }));
                    }
                }

                Frame::VoiceMessage { message_id, sender_id, timestamp, duration_secs, mime, audio_b64, .. } => {
                    let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                    let file_key = match state.app.get_file_key() { Ok(k) => k, Err(_) => continue };
                    let audio = match base64::engine::general_purpose::STANDARD.decode(&audio_b64) {
                        Ok(d) => d, Err(_) => continue,
                    };
                    let stored_name = match state.file_store.store(&file_key, &audio) {
                        Ok(n) => n, Err(e) => { log::error!("store voice: {e}"); continue }
                    };
                    let new_file_id = uuid::Uuid::new_v4().to_string();
                    let file_rec = FileRecord {
                        file_id: new_file_id.clone(),
                        message_id: message_id.clone(),
                        original_name: format!("voice_{message_id}.wav"),
                        stored_name,
                        mime_type: mime.clone(),
                        size: audio.len() as i64,
                        sha256: file_store::FileStore::sha256_hex(&audio),
                        is_image: false,
                        width: None,
                        height: None,
                        created_at: now_ms(),
                    };
                    let _ = state.db.insert_file_record(&db_key, &file_rec);

                    // Find or create the conversation, same as Frame::Message.
                    let convs = match state.db.get_conversations(&db_key) { Ok(c) => c, Err(_) => continue };
                    let conv = if let Some(existing) = convs.iter().find(|c| c.peer_device_id.as_deref() == Some(&sender_id)) {
                        existing.clone()
                    } else {
                        let peer = state.db.get_device_by_id(&db_key, &sender_id).ok().flatten();
                        let display_name = peer.map(|p| p.display_name).unwrap_or_else(|| sender_id[..8.min(sender_id.len())].to_string());
                        let new_conv = Conversation {
                            conv_id: uuid::Uuid::new_v4().to_string(), conv_type: "private".to_string(),
                            peer_device_id: Some(sender_id.clone()), group_id: None,
                            display_name, last_message_at: 0, unread_count: 0, pinned: false, muted: false,
                        };
                        let _ = state.db.upsert_conversation(&db_key, &new_conv);
                        new_conv
                    };

                    let msg = Message {
                        message_id: message_id.clone(), conv_id: conv.conv_id.clone(),
                        sender_id: sender_id.clone(), direction: "received".to_string(),
                        msg_type: "voice".to_string(), content: duration_secs.to_string(),
                        timestamp: if timestamp > 0 { timestamp } else { now_ms() },
                        sequence: 0, status: "delivered".to_string(),
                        burn_after_read: false, burned: false,
                        file_id: Some(new_file_id), reply_to: None,
                    };
                    let _ = state.db.insert_message(&db_key, &msg);
                    let _ = state.network.send_to_peer(&sender_id, protocol::encode_frame(&Frame::Ack { message_id: message_id.clone(), ack_type: "delivered".to_string() }));
                    let _ = app_handle.emit("message-received", serde_json::json!({ "conversation_id": conv.conv_id }));
                }

                Frame::ProfileUpdate { sender_id, display_name } => {
                    let db_key = match state.app.get_db_key() { Ok(k) => k, Err(_) => continue };
                    let _ = state.db.update_device_name(&db_key, &sender_id, &display_name);
                    let _ = app_handle.emit("profile-update", serde_json::json!({ "device_id": sender_id, "display_name": display_name }));
                }

                _ => {}
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = dirs_or_default();
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    let db_path = data_dir.join(".pl_cache");
    let files_dir = data_dir.join(".pl_assets");
    let db = Database::open(&db_path).expect("open database");
    db.init_schema().expect("init db schema");
    let file_store = file_store::FileStore::new(&files_dir).expect("create file store");
    let network = Arc::new(network::NetworkManager::new(network::DEFAULT_PORT));
    let runtime = Arc::new(tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("create tokio runtime"));
    let device_id = db.get_meta_string("device_id").ok().flatten().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let app_state = state::AppState::new(data_dir, device_id.clone());
    if db.get_meta("kdf_salt").ok().flatten().is_some() { app_state.set_initialized(true); }

    let state_data = Arc::new(AppStateData {
        app: app_state, db, file_store, network, runtime,
        call_rooms: Arc::new(Mutex::new(HashMap::new())),
    });

    let nm = state_data.network.clone();
    let port = state_data.network.port;
    let rt = state_data.runtime.clone();
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    rt.block_on(async { let _ = nm.start_listener(port, frame_tx).await; });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state_data)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = window.emit("window-blur", ());
            }
        })
        .setup(move |app| {
            let state = app.state::<Arc<AppStateData>>().inner().clone();
            let app_handle = app.handle().clone();
            spawn_frame_consumer(frame_rx, state, app_handle);

            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::apply_vibrancy;
                    use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), None);
                }
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window_vibrancy::apply_mica(&window, None);
                }
            }
            Ok(())
        })
       .invoke_handler(tauri::generate_handler![
           vault_exists, create_vault, unlock_vault, lock_vault, is_unlocked, is_ui_locked,
           get_device_id, get_device_name, get_device_info, get_app_version,
           get_devices, get_local_ip, add_device, delete_device, discover_peers, get_connected_peers,
           get_conversations, get_or_create_private_conversation, reset_unread,
           get_messages, save_local_message, search_messages, update_message_status, burn_message, delete_message,
           get_setting, set_setting, get_all_settings, save_downloaded_file, download_release_asset, check_latest_release,
           save_file_from_base64, load_file_to_base64,
           start_network, stop_network, connect_to_peer, send_frame_to_peer, send_message_frame, send_file_frame,
           export_backup, import_backup,
           self_destruct,
           send_friend_request, accept_friend_request, reject_friend_request, get_friend_requests,
           update_profile, get_avatar,
           send_voice_frame, send_voice_call_invite, send_voice_call_response, send_voice_call_end,
           voice_call_start_room, voice_call_join, voice_call_leave, voice_call_end_room,
           send_voice_message_frame, send_sticker_frame,
       ])
        .run(tauri::generate_context!())
        .expect("error while running PhantomLink");
}

fn dirs_or_default() -> std::path::PathBuf {
    if let Some(base) = std::env::var_os("HOME") {
        let p = std::path::PathBuf::from(base).join("Library").join("Application Support").join(".pl_session_cache");
        if p.exists() || cfg!(target_os = "macos") { return p; }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") { return std::path::PathBuf::from(local).join(".pl_session_cache"); }
    std::env::temp_dir().join(".pl_session_cache")
}
