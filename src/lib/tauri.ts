import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage, Conversation, Device, DeviceInfo, NetworkInfo,
  AppSettings, FileRecord, DiscoveredPeer, FriendRequest,
} from "../types";

export const api = {
  vaultExists: () => invoke<boolean>("vault_exists"),
  createVault: (password: string, deviceName: string) =>
    invoke<string>("create_vault", { password, deviceName }),
  unlockVault: (password: string) => invoke<boolean>("unlock_vault", { password }),
  lockVault: () => invoke<void>("lock_vault"),
  isUnlocked: () => invoke<boolean>("is_unlocked"),
  isUiLocked: () => invoke<boolean>("is_ui_locked"),
  getDeviceId: () => invoke<string>("get_device_id"),
  getDeviceName: () => invoke<string>("get_device_name"),
  getDeviceInfo: () => invoke<DeviceInfo>("get_device_info"),
  getAppVersion: () => invoke<string>("get_app_version"),
  getDevices: () => invoke<Device[]>("get_devices"),
  getLocalIp: () => invoke<string[]>("get_local_ip"),
  addDevice: (ip: string, port: number | null, displayName: string) =>
    invoke<Device>("add_device", { ip, port, displayName }),
  deleteDevice: (deviceId: string) =>
    invoke<void>("delete_device", { deviceId }),
  discoverPeers: () => invoke<DiscoveredPeer[]>("discover_peers"),
  getConnectedPeers: () => invoke<string[]>("get_connected_peers"),
  getConversations: () => invoke<Conversation[]>("get_conversations"),
  getOrCreatePrivateConversation: (peerDeviceId: string) =>
    invoke<Conversation>("get_or_create_private_conversation", { peerDeviceId }),
  resetUnread: (convId: string) => invoke<void>("reset_unread", { convId }),
  getMessages: (convId: string, limit?: number, offset?: number) =>
    invoke<ChatMessage[]>("get_messages", { convId, limit, offset }),
  saveLocalMessage: (
    convId: string, msgType: string, content: string,
    direction: string, burnAfterRead: boolean, fileId?: string | null,
  ) => invoke<ChatMessage>("save_local_message", {
    convId, msgType, content, direction, burnAfterRead, fileId,
  }),
  searchMessages: (query: string) => invoke<ChatMessage[]>("search_messages", { query }),
  updateMessageStatus: (messageId: string, status: string) =>
    invoke<void>("update_message_status", { messageId, status }),
  burnMessage: (messageId: string) => invoke<void>("burn_message", { messageId }),
  deleteMessage: (messageId: string) => invoke<void>("delete_message", { messageId }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  getAllSettings: () => invoke<AppSettings>("get_all_settings"),
  saveFileFromBase64: (
    fileName: string, mimeType: string, dataB64: string, messageId?: string,
  ) => invoke<FileRecord>("save_file_from_base64", { fileName, mimeType, dataB64, messageId }),
  loadFileToBase64: (storedName: string) => invoke<string>("load_file_to_base64", { storedName }),
  startNetwork: (displayName: string) => invoke<NetworkInfo>("start_network", { displayName }),
  stopNetwork: () => invoke<void>("stop_network"),
  connectToPeer: (ip: string, port: number, deviceId: string) =>
    invoke<boolean>("connect_to_peer", { ip, port, deviceId }),
  sendFrameToPeer: (deviceId: string, frameJson: string) =>
    invoke<void>("send_frame_to_peer", { deviceId, frameJson }),
  sendMessageFrame: (
    peerDeviceId: string, messageId: string, msgType: string,
    content: string, burnAfterRead: boolean,
  ) => invoke<void>("send_message_frame", {
    peerDeviceId, messageId, msgType, content, burnAfterRead,
  }),
  sendFileFrame: (peerDeviceId: string, messageId: string, fileId: string) =>
    invoke<void>("send_file_frame", { peerDeviceId, messageId, fileId }),
  exportBackup: (password: string, destPath: string) =>
    invoke<string>("export_backup", { password, destPath }),
  importBackup: (password: string, srcPath: string) =>
    invoke<boolean>("import_backup", { password, srcPath }),
  selfDestruct: () => invoke<void>("self_destruct"),
  // v1.3 additions
  sendFriendRequest: (ip: string, port: number | null, displayNameHint: string) =>
    invoke<void>("send_friend_request", { ip, port, displayNameHint }),
  acceptFriendRequest: (requestId: string, fromDeviceId: string) =>
    invoke<void>("accept_friend_request", { requestId, fromDeviceId }),
  rejectFriendRequest: (requestId: string, fromDeviceId: string) =>
    invoke<void>("reject_friend_request", { requestId, fromDeviceId }),
  getFriendRequests: () => invoke<FriendRequest[]>("get_friend_requests"),
  updateProfile: (displayName?: string | null, avatarB64?: string | null) =>
    invoke<void>("update_profile", { displayName, avatarB64 }),
  getAvatar: (deviceId: string) => invoke<string | null>("get_avatar", { deviceId }),
  sendVoiceFrame: (peerDeviceId: string, roomId: string, sequence: number, audioData: string, sampleRate: number, channels: number) =>
    invoke<void>("send_voice_frame", { peerDeviceId, roomId, sequence, audioData, sampleRate, channels }),
  sendVoiceCallInvite: (peerDeviceId: string, roomId: string, callType: string) =>
    invoke<void>("send_voice_call_invite", { peerDeviceId, roomId, callType }),
  sendVoiceCallResponse: (peerDeviceId: string, roomId: string, accepted: boolean) =>
    invoke<void>("send_voice_call_response", { peerDeviceId, roomId, accepted }),
  sendVoiceCallEnd: (peerDeviceId: string, roomId: string) =>
    invoke<void>("send_voice_call_end", { peerDeviceId, roomId }),
  // v1.4 additions: room-based multi-party calls + dedicated voice messages
  voiceCallStartRoom: (roomId: string) =>
    invoke<void>("voice_call_start_room", { roomId }),
  voiceCallJoin: (hostDeviceId: string, roomId: string) =>
    invoke<void>("voice_call_join", { hostDeviceId, roomId }),
  voiceCallLeave: (hostDeviceId: string, roomId: string) =>
    invoke<void>("voice_call_leave", { hostDeviceId, roomId }),
  voiceCallEndRoom: (roomId: string) =>
    invoke<void>("voice_call_end_room", { roomId }),
  sendVoiceMessageFrame: (peerDeviceId: string, messageId: string, durationSecs: number, mime: string, audioB64: string) =>
    invoke<void>("send_voice_message_frame", { peerDeviceId, messageId, durationSecs, mime, audioB64 }),
  sendStickerFrame: (peerDeviceId: string, messageId: string, stickerId: string) =>
    invoke<void>("send_sticker_frame", { peerDeviceId, messageId, stickerId }),
  // v1.4.1: save a downloaded release asset into the user's Downloads folder
  saveDownloadedFile: (fileName: string, dataB64: string) =>
    invoke<string>("save_downloaded_file", { fileName, dataB64 }),
  downloadReleaseAsset: (url: string, fileName: string) =>
    invoke<string>("download_release_asset", { url, fileName }),
  checkLatestRelease: () =>
    invoke<{ tag_name?: string; name?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] }>("check_latest_release"),
};
