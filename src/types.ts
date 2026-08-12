export interface Device {
  device_id: string;
  display_name: string;
  public_key_b64: string;
  fingerprint: string;
  trusted: boolean;
  last_seen: number;
}

export interface Conversation {
  conv_id: string;
  conv_type: "private" | "group";
  peer_device_id: string | null;
  group_id: string | null;
  display_name: string;
  last_message_at: number;
  unread_count: number;
  pinned: boolean;
  muted: boolean;
}

export interface FileRecord {
  file_id: string;
  message_id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  is_image: boolean;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface ChatMessage {
  message_id: string;
  conv_id: string;
  sender_id: string;
  direction: "sent" | "received";
  msg_type: "text" | "image" | "file" | "emoji" | "system";
  content: string;
  timestamp: number;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  burn_after_read: boolean;
  file_info: FileRecord | null;
  reply_to: string | null;
}

export interface AppSettings {
  lock_timeout_minutes: number;
  clipboard_clear_seconds: number;
  blur_on_focus_loss: boolean;
  lock_on_sleep: boolean;
  auto_backup_enabled: boolean;
  auto_backup_interval_hours: number;
  auto_backup_max: number;
  burn_after_read_delay: number;
  network_port: number;
}

export interface DeviceInfo {
  device_id: string;
  display_name: string;
  fingerprint: string;
  pairing_code: string;
}

export interface NetworkInfo {
  device_id: string;
  fingerprint: string;
  local_ips: string[];
  port: number;
}

export type AppView = "setup" | "unlock" | "main" | "locked";
export type NavSection = "chats" | "contacts" | "files" | "settings";

export interface DiscoveredPeer {
  device_id: string;
  display_name: string;
  ip: string;
  port: number;
  fingerprint: string;
}
