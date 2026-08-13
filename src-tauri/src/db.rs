//! Encrypted SQLite database operations.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use zeroize::Zeroizing;
use base64::Engine as _;

use crate::crypto;

pub struct Database {
    conn: Mutex<Connection>,
}

// ---- Data types (plaintext, used in Rust<->JS boundary) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub display_name: String,
    pub public_key_b64: String,
    pub fingerprint: String,
    pub trusted: bool,
    pub last_seen: i64,
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub conv_id: String,
    pub conv_type: String, // "private" | "group"
    pub peer_device_id: Option<String>,
    pub group_id: Option<String>,
    pub display_name: String,
    pub last_message_at: i64,
    pub unread_count: i64,
    pub pinned: bool,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub message_id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub direction: String, // "sent" | "received"
    pub msg_type: String,  // text/image/file/emoji/system
    pub content: String,   // plaintext content (decrypted from DB)
    pub timestamp: i64,
    pub sequence: i64,
    pub status: String,    // pending/sent/delivered/read/failed
    pub burn_after_read: bool,
    pub burned: bool,
    pub file_id: Option<String>,
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub file_id: String,
    pub message_id: String,
    pub original_name: String,
    pub stored_name: String,
    pub mime_type: String,
    pub size: i64,
    pub sha256: String,
    pub is_image: bool,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupRecord {
    pub group_id: String,
    pub group_name: String,
    pub creator_id: String,
    pub members: Vec<String>,
    pub gsk_version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub message_id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub direction: String,
    pub msg_type: String,
    pub content: String,
    pub timestamp: i64,
    pub status: String,
    pub burn_after_read: bool,
    pub file_info: Option<FileRecord>,
    pub reply_to: Option<String>,
}

impl Database {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("db open: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("db pragma: {e}"))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value BLOB
            );

            CREATE TABLE IF NOT EXISTS devices (
                device_id   TEXT PRIMARY KEY,
                display_name BLOB,
                public_key  BLOB,
                fingerprint TEXT,
                trusted     INTEGER DEFAULT 0,
                last_seen   INTEGER DEFAULT 0,
                avatar      BLOB
            );

            CREATE TABLE IF NOT EXISTS conversations (
                conv_id        TEXT PRIMARY KEY,
                type           TEXT,
                peer_device_id TEXT,
                group_id       TEXT,
                display_name   BLOB,
                last_message_at INTEGER DEFAULT 0,
                unread_count   INTEGER DEFAULT 0,
                pinned         INTEGER DEFAULT 0,
                muted          INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                message_id    TEXT PRIMARY KEY,
                conv_id       TEXT,
                sender_id     TEXT,
                direction     TEXT,
                msg_type      TEXT,
                payload       BLOB,
                timestamp     INTEGER,
                sequence      INTEGER DEFAULT 0,
                status        TEXT DEFAULT 'sent',
                burn_after_read INTEGER DEFAULT 0,
                burned        INTEGER DEFAULT 0,
                file_id       TEXT,
                reply_to      TEXT,
                deleted       INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS files (
                file_id       TEXT PRIMARY KEY,
                message_id    TEXT,
                original_name BLOB,
                stored_name   TEXT,
                mime_type     BLOB,
                size          INTEGER,
                sha256        TEXT,
                is_image      INTEGER DEFAULT 0,
                width         INTEGER,
                height        INTEGER,
                thumbnail     BLOB,
                created_at    INTEGER
            );

            CREATE TABLE IF NOT EXISTS groups (
                group_id      TEXT PRIMARY KEY,
                group_name    BLOB,
                creator_id    TEXT,
                members       BLOB,
                gsk_version   INTEGER DEFAULT 1,
                gsk_encrypted BLOB,
                created_at    INTEGER,
                updated_at    INTEGER,
                dissolved     INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS outbox (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_id   TEXT,
                message_id     TEXT,
                encrypted_frame BLOB,
                created_at     INTEGER,
                expires_at     INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
            CREATE INDEX IF NOT EXISTS idx_outbox_recipient ON outbox(recipient_id);
            "#,
        )
        .map_err(|e| format!("db schema: {e}"))?;

        // v1.2: add ip/port columns to devices for auto-reconnect
        let _ = conn.execute("ALTER TABLE devices ADD COLUMN ip TEXT DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE devices ADD COLUMN port INTEGER DEFAULT 0", []);

        Ok(())
    }

    // ---- Meta ----

    pub fn set_meta(&self, key: &str, value: &[u8]) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES(?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("db set_meta: {e}"))?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT value FROM meta WHERE key=?1")
            .map_err(|e| format!("db prepare: {e}"))?;
        let mut rows = stmt
            .query(params![key])
            .map_err(|e| format!("db query: {e}"))?;
        if let Some(row) = rows.next().map_err(|e| format!("db row: {e}"))? {
            let v: Vec<u8> = row.get(0).map_err(|e| format!("db get: {e}"))?;
            Ok(Some(v))
        } else {
            Ok(None)
        }
    }

    pub fn get_meta_string(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.get_meta(key)?.map(|v| String::from_utf8_lossy(&v).to_string()))
    }

    // ---- Devices ----

    pub fn upsert_device(
        &self,
        key: &Zeroizing<[u8; 32]>,
        device: &Device,
        public_key_bytes: &[u8],
    ) -> Result<(), String> {
        let name_enc = crypto::encrypt_field(key.as_ref(), device.display_name.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO devices(device_id, display_name, public_key, fingerprint, trusted, last_seen)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                device.device_id,
                name_enc,
                public_key_bytes,
                device.fingerprint,
                device.trusted as i32,
                device.last_seen,
            ],
        )
        .map_err(|e| format!("db upsert_device: {e}"))?;
        Ok(())
    }

    pub fn get_devices(&self, key: &Zeroizing<[u8; 32]>) -> Result<Vec<Device>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT device_id, display_name, public_key, fingerprint, trusted, last_seen, ip, port FROM devices")
            .map_err(|e| format!("db prepare: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let name_enc: String = row.get(1)?;
                let pubkey: Vec<u8> = row.get(2)?;
                Ok((row.get::<_, String>(0)?, name_enc, pubkey, row.get::<_, String>(3)?, row.get::<_, i32>(4)?, row.get::<_, i64>(5)?, row.get::<_, Option<String>>(6)?.unwrap_or_default(), row.get::<_, Option<i64>>(7)?.unwrap_or(0) as u16))
            })
            .map_err(|e| format!("db query: {e}"))?;

        let mut devices = Vec::new();
        for r in rows {
            let (device_id, name_enc, pubkey, fingerprint, trusted, last_seen, ip, port) =
                r.map_err(|e| format!("db row: {e}"))?;
            let name_bytes = crypto::decrypt_field(key.as_ref(), &name_enc)?;
            let display_name = String::from_utf8_lossy(&name_bytes).to_string();
            devices.push(Device {
                device_id,
                display_name,
                public_key_b64: base64::engine::general_purpose::STANDARD.encode(&pubkey),
                fingerprint,
                trusted: trusted != 0,
                last_seen,
                ip,
                port,
            });
        }
        Ok(devices)
    }

    pub fn get_device_by_id(
        &self,
        key: &Zeroizing<[u8; 32]>,
        device_id: &str,
    ) -> Result<Option<Device>, String> {
        Ok(self.get_devices(key)?.into_iter().find(|d| d.device_id == device_id))
    }

    pub fn set_device_trusted(&self, device_id: &str, trusted: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET trusted=?1 WHERE device_id=?2",
            params![trusted as i32, device_id],
        )
        .map_err(|e| format!("db set_trusted: {e}"))?;
        Ok(())
    }

    pub fn update_device_last_seen(&self, device_id: &str, ts: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET last_seen=?1 WHERE device_id=?2",
            params![ts, device_id],
        )
        .map_err(|e| format!("db update_last_seen: {e}"))?;
        Ok(())
    }

    // ---- Conversations ----

    pub fn upsert_conversation(
        &self,
        key: &Zeroizing<[u8; 32]>,
        conv: &Conversation,
    ) -> Result<(), String> {
        let name_enc = crypto::encrypt_field(key.as_ref(), conv.display_name.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO conversations(conv_id, type, peer_device_id, group_id, display_name, last_message_at, unread_count, pinned, muted)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                conv.conv_id,
                conv.conv_type,
                conv.peer_device_id,
                conv.group_id,
                name_enc,
                conv.last_message_at,
                conv.unread_count,
                conv.pinned as i32,
                conv.muted as i32,
            ],
        )
        .map_err(|e| format!("db upsert_conv: {e}"))?;
        Ok(())
    }

    pub fn get_conversations(
        &self,
        key: &Zeroizing<[u8; 32]>,
    ) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT conv_id, type, peer_device_id, group_id, display_name, last_message_at, unread_count, pinned, muted FROM conversations ORDER BY pinned DESC, last_message_at DESC")
            .map_err(|e| format!("db prepare: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let name_enc: String = row.get(4)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    name_enc,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i32>(7)?,
                    row.get::<_, i32>(8)?,
                ))
            })
            .map_err(|e| format!("db query: {e}"))?;

        let mut convs = Vec::new();
        for r in rows {
            let (conv_id, ct, peer, gid, name_enc, last_at, unread, pinned, muted) =
                r.map_err(|e| format!("db row: {e}"))?;
            let name_bytes = crypto::decrypt_field(key.as_ref(), &name_enc)?;
            let display_name = String::from_utf8_lossy(&name_bytes).to_string();
            convs.push(Conversation {
                conv_id,
                conv_type: ct,
                peer_device_id: peer,
                group_id: gid,
                display_name,
                last_message_at: last_at,
                unread_count: unread,
                pinned: pinned != 0,
                muted: muted != 0,
            });
        }
        Ok(convs)
    }

    pub fn get_conversation(&self, key: &Zeroizing<[u8; 32]>, conv_id: &str) -> Result<Option<Conversation>, String> {
        Ok(self.get_conversations(key)?.into_iter().find(|c| c.conv_id == conv_id))
    }

    pub fn reset_unread(&self, conv_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET unread_count=0 WHERE conv_id=?1",
            params![conv_id],
        )
        .map_err(|e| format!("db reset_unread: {e}"))?;
        Ok(())
    }

    // ---- Messages ----

    pub fn insert_message(
        &self,
        key: &Zeroizing<[u8; 32]>,
        msg: &Message,
    ) -> Result<(), String> {
        let payload_enc = crypto::encrypt_field(key.as_ref(), msg.content.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO messages(message_id, conv_id, sender_id, direction, msg_type, payload, timestamp, sequence, status, burn_after_read, burned, file_id, reply_to, deleted)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)",
            params![
                msg.message_id,
                msg.conv_id,
                msg.sender_id,
                msg.direction,
                msg.msg_type,
                payload_enc,
                msg.timestamp,
                msg.sequence,
                msg.status,
                msg.burn_after_read as i32,
                msg.burned as i32,
                msg.file_id,
                msg.reply_to,
            ],
        )
        .map_err(|e| format!("db insert_msg: {e}"))?;

        // Update conversation last_message_at
        conn.execute(
            "UPDATE conversations SET last_message_at=?1 WHERE conv_id=?2",
            params![msg.timestamp, msg.conv_id],
        )
        .map_err(|e| format!("db update_conv_ts: {e}"))?;

        // Increment unread if received message
        if msg.direction == "received" {
            conn.execute(
                "UPDATE conversations SET unread_count = unread_count + 1 WHERE conv_id=?1",
                params![msg.conv_id],
            )
            .map_err(|e| format!("db inc_unread: {e}"))?;
        }

        Ok(())
    }

    pub fn get_messages(
        &self,
        key: &Zeroizing<[u8; 32]>,
        conv_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT message_id, conv_id, sender_id, direction, msg_type, payload, timestamp, status, burn_after_read, burned, file_id, reply_to
                 FROM messages WHERE conv_id=?1 AND deleted=0 AND burned=0
                 ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(|e| format!("db prepare: {e}"))?;

        let rows = stmt
            .query_map(params![conv_id, limit, offset], |row| {
                let payload_enc: String = row.get(5)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    payload_enc,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i32>(8)?,
                    row.get::<_, i32>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                ))
            })
            .map_err(|e| format!("db query: {e}"))?;

        let mut messages = Vec::new();
        for r in rows {
            let (message_id, cid, sender, dir, mtype, payload_enc, ts, status, burn, burned, file_id, reply_to) =
                r.map_err(|e| format!("db row: {e}"))?;
            let content_bytes = crypto::decrypt_field(key.as_ref(), &payload_enc)?;
            let content = String::from_utf8_lossy(&content_bytes).to_string();

            let file_info = if let Some(ref fid) = file_id {
                self.get_file_record(key, fid).ok().flatten()
            } else {
                None
            };

            messages.push(ChatMessage {
                message_id,
                conv_id: cid,
                sender_id: sender,
                direction: dir,
                msg_type: mtype,
                content,
                timestamp: ts,
                status,
                burn_after_read: burn != 0,
                file_info,
                reply_to,
            });
        }

        // Reverse to chronological order (we queried DESC)
        messages.reverse();
        Ok(messages)
    }

    pub fn update_message_status(&self, message_id: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET status=?1 WHERE message_id=?2",
            params![status, message_id],
        )
        .map_err(|e| format!("db update_status: {e}"))?;
        Ok(())
    }

    pub fn burn_message(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET burned=1 WHERE message_id=?1",
            params![message_id],
        )
        .map_err(|e| format!("db burn: {e}"))?;
        Ok(())
    }

    pub fn delete_message(&self, message_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET deleted=1 WHERE message_id=?1",
            params![message_id],
        )
        .map_err(|e| format!("db delete_msg: {e}"))?;
        Ok(())
    }

    // ---- Files ----

    pub fn insert_file_record(
        &self,
        key: &Zeroizing<[u8; 32]>,
        f: &FileRecord,
    ) -> Result<(), String> {
        let name_enc = crypto::encrypt_field(key.as_ref(), f.original_name.as_bytes())?;
        let mime_enc = crypto::encrypt_field(key.as_ref(), f.mime_type.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO files(file_id, message_id, original_name, stored_name, mime_type, size, sha256, is_image, width, height, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                f.file_id,
                f.message_id,
                name_enc,
                f.stored_name,
                mime_enc,
                f.size,
                f.sha256,
                f.is_image as i32,
                f.width,
                f.height,
                f.created_at,
            ],
        )
        .map_err(|e| format!("db insert_file: {e}"))?;
        Ok(())
    }

    pub fn get_file_record(
        &self,
        key: &Zeroizing<[u8; 32]>,
        file_id: &str,
    ) -> Result<Option<FileRecord>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT file_id, message_id, original_name, stored_name, mime_type, size, sha256, is_image, width, height, created_at FROM files WHERE file_id=?1")
            .map_err(|e| format!("db prepare: {e}"))?;
        let mut rows = stmt
            .query(params![file_id])
            .map_err(|e| format!("db query: {e}"))?;
        if let Some(row) = rows.next().map_err(|e| format!("db row: {e}"))? {
            let name_enc: String = row.get(2).map_err(|e| format!("db: {e}"))?;
            let mime_enc: String = row.get(4).map_err(|e| format!("db: {e}"))?;
            let name_bytes = crypto::decrypt_field(key.as_ref(), &name_enc)?;
            let mime_bytes = crypto::decrypt_field(key.as_ref(), &mime_enc)?;
            Ok(Some(FileRecord {
                file_id: row.get(0).map_err(|e| format!("db: {e}"))?,
                message_id: row.get(1).map_err(|e| format!("db: {e}"))?,
                original_name: String::from_utf8_lossy(&name_bytes).to_string(),
                stored_name: row.get(3).map_err(|e| format!("db: {e}"))?,
                mime_type: String::from_utf8_lossy(&mime_bytes).to_string(),
                size: row.get(5).map_err(|e| format!("db: {e}"))?,
                sha256: row.get(6).map_err(|e| format!("db: {e}"))?,
                is_image: row.get::<_, i32>(7).map_err(|e| format!("db: {e}"))? != 0,
                width: row.get(8).map_err(|e| format!("db: {e}"))?,
                height: row.get(9).map_err(|e| format!("db: {e}"))?,
                created_at: row.get(10).map_err(|e| format!("db: {e}"))?,
            }))
        } else {
            Ok(None)
        }
    }

    // ---- Groups ----

    pub fn upsert_group(
        &self,
        key: &Zeroizing<[u8; 32]>,
        g: &GroupRecord,
        gsk_encrypted: &[u8],
    ) -> Result<(), String> {
        let name_enc = crypto::encrypt_field(key.as_ref(), g.group_name.as_bytes())?;
        let members_json = serde_json::to_string(&g.members).unwrap_or_default();
        let members_enc = crypto::encrypt_field(key.as_ref(), members_json.as_bytes())?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO groups(group_id, group_name, creator_id, members, gsk_version, gsk_encrypted, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                g.group_id,
                name_enc,
                g.creator_id,
                members_enc,
                g.gsk_version,
                gsk_encrypted,
                g.created_at,
                g.updated_at,
            ],
        )
        .map_err(|e| format!("db upsert_group: {e}"))?;
        Ok(())
    }

    pub fn get_groups(&self, key: &Zeroizing<[u8; 32]>) -> Result<Vec<GroupRecord>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT group_id, group_name, creator_id, members, gsk_version, created_at, updated_at FROM groups WHERE dissolved=0")
            .map_err(|e| format!("db prepare: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let name_enc: String = row.get(1)?;
                let members_enc: String = row.get(3)?;
                Ok((
                    row.get::<_, String>(0)?,
                    name_enc,
                    row.get::<_, String>(2)?,
                    members_enc,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| format!("db query: {e}"))?;

        let mut groups = Vec::new();
        for r in rows {
            let (gid, name_enc, creator, members_enc, ver, created, updated) =
                r.map_err(|e| format!("db row: {e}"))?;
            let name_bytes = crypto::decrypt_field(key.as_ref(), &name_enc)?;
            let group_name = String::from_utf8_lossy(&name_bytes).to_string();
            let members_bytes = crypto::decrypt_field(key.as_ref(), &members_enc)?;
            let members_json = String::from_utf8_lossy(&members_bytes).to_string();
            let members: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
            groups.push(GroupRecord {
                group_id: gid,
                group_name,
                creator_id: creator,
                members,
                gsk_version: ver,
                created_at: created,
                updated_at: updated,
            });
        }
        Ok(groups)
    }

    pub fn dissolve_group(&self, group_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE groups SET dissolved=1 WHERE group_id=?1",
            params![group_id],
        )
        .map_err(|e| format!("db dissolve: {e}"))?;
        Ok(())
    }

    // ---- Search ----

    pub fn search_messages(
        &self,
        key: &Zeroizing<[u8; 32]>,
        query: &str,
        limit: i64,
    ) -> Result<Vec<ChatMessage>, String> {
        // Since content is encrypted, we need to decrypt in memory and filter.
        // For moderate message counts this is acceptable.
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT message_id, conv_id, sender_id, direction, msg_type, payload, timestamp, status, burn_after_read, file_id, reply_to
                 FROM messages WHERE deleted=0 AND burned=0 AND msg_type='text'
                 ORDER BY timestamp DESC LIMIT 2000",
            )
            .map_err(|e| format!("db prepare: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                let payload_enc: String = row.get(5)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    payload_enc,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i32>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|e| format!("db query: {e}"))?;

        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        for r in rows {
            let (message_id, cid, sender, dir, mtype, payload_enc, ts, status, burn, file_id, reply_to) =
                r.map_err(|e| format!("db row: {e}"))?;
            let content_bytes = crypto::decrypt_field(key.as_ref(), &payload_enc)?;
            let content = String::from_utf8_lossy(&content_bytes).to_string();
            if content.to_lowercase().contains(&query_lower) {
                results.push(ChatMessage {
                    message_id,
                    conv_id: cid,
                    sender_id: sender,
                    direction: dir,
                    msg_type: mtype,
                    content,
                    timestamp: ts,
                    status,
                    burn_after_read: burn != 0,
                    file_info: None,
                    reply_to,
                });
                if results.len() as i64 >= limit {
                    break;
                }
            }
        }
        Ok(results)
    }

    pub fn delete_device(&self, device_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM devices WHERE device_id=?1", params![device_id])
            .map_err(|e| format!("db delete_device: {e}"))?;
        conn.execute("DELETE FROM conversations WHERE peer_device_id=?1", params![device_id])
            .map_err(|e| format!("db delete_conv: {e}"))?;
        Ok(())
    }

    pub fn update_message_file_id(&self, message_id: &str, file_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE messages SET file_id=?1 WHERE message_id=?2", params![file_id, message_id])
            .map_err(|e| format!("db update_file_id: {e}"))?;
        Ok(())
    }

   pub fn delete_conv_messages(&self, conv_id: &str) -> Result<(), String> {
       let conn = self.conn.lock().unwrap();
       conn.execute("UPDATE messages SET deleted=1 WHERE conv_id=?1", params![conv_id])
           .map_err(|e| format!("db delete_conv_msgs: {e}"))?;
       Ok(())
   }

    pub fn set_device_address(&self, device_id: &str, ip: &str, port: u16) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE devices SET ip=?1, port=?2 WHERE device_id=?3", params![ip, port as i64, device_id])
            .map_err(|e| format!("db set_addr: {e}"))?;
        Ok(())
    }

    pub fn wipe_all(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM messages; DELETE FROM conversations; DELETE FROM devices; DELETE FROM files; DELETE FROM groups; DELETE FROM outbox; DELETE FROM meta; VACUUM;",
        ).map_err(|e| format!("db wipe: {e}"))?;
        Ok(())
    }
}
