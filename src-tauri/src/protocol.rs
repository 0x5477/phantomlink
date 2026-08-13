//! Wire protocol: message frame definitions and serialization.

use serde::{Deserialize, Serialize};

/// Top-level frame type for all P2P communication.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "frame_type")]
pub enum Frame {
    /// Encrypted chat message (text/image/file/emoji).
    #[serde(rename = "message")]
    Message {
        message_id: String,
        sender_id: String,
        recipient_id: String, // device_id or group_id
        sequence: i64,
        timestamp: i64,
        msg_type: String,
        encrypted_payload: String, // base64
        nonce: String,             // base64
        flags: Vec<String>,        // e.g. ["burn_after_read"]
        reply_to: Option<String>,
    },

    /// File metadata (sent before file chunks).
    #[serde(rename = "file_meta")]
    FileMeta {
        file_id: String,
        message_id: String,
        name: String,
        size: i64,
        mime: String,
        sha256: String,
        total_chunks: i64,
        chunk_size: i64,
        is_image: bool,
        thumbnail_b64: Option<String>,
        width: Option<i64>,
        height: Option<i64>,
    },

    /// File data chunk.
    #[serde(rename = "file_chunk")]
    FileChunk {
        file_id: String,
        chunk_index: i64,
        encrypted_data: String, // base64
        is_last: bool,
    },

    /// File transfer complete acknowledgment.
    #[serde(rename = "file_ack")]
    FileAck {
        file_id: String,
        success: bool,
    },

    /// Read receipt / delivery confirmation.
    #[serde(rename = "ack")]
    Ack {
        message_id: String,
        ack_type: String, // "delivered" | "read" | "burned"
    },

    /// X25519 ephemeral key exchange.
    #[serde(rename = "key_exchange")]
    KeyExchange {
        sender_id: String,
        public_key_b64: String,
    },

    /// Group control: create / invite / leave / dissolve / key rotation.
    #[serde(rename = "group_control")]
    GroupControl {
        group_id: String,
        action: String,   // "create" | "invite" | "leave" | "dissolve" | "key_update"
        members: Vec<String>,
        group_name: Option<String>,
        gsk_encrypted_b64: Option<String>, // GSK encrypted for each member
        gsk_version: i64,
    },

    /// Presence: online/offline heartbeat.
    #[serde(rename = "presence")]
    Presence {
        sender_id: String,
        status: String, // "online" | "away"
    },

    /// Device pairing request/response.
    #[serde(rename = "pair")]
    Pair {
        sender_id: String,
        display_name: String,
        public_key_b64: String,
        code: String, // 6-digit pairing code
    },
}

impl Frame {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| format!("frame parse: {e}"))
    }
}

/// On-the-wire: frames are sent as length-prefixed JSON over TCP.
/// 4-byte big-endian length + JSON bytes.
pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    let json = frame.to_json();
    let bytes = json.as_bytes();
    let len = bytes.len() as u32;
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    out
}
