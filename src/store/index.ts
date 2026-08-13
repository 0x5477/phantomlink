import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppView, AppSettings, ChatMessage, Conversation, Device, NavSection,
  FriendRequest, VoiceCallParticipant, VoiceCallTarget,
} from "../types";
import { api } from "../lib/tauri";

interface AppState {
  view: AppView;
  navSection: NavSection;
  conversations: Conversation[];
  activeConvId: string | null;
  messages: Record<string, ChatMessage[]>;
  devices: Device[];
  settings: AppSettings;
  locked: boolean;
  deviceId: string | null;
  deviceName: string | null;
  networkActive: boolean;
  localIps: string[];
  pairingCode: string;
  fingerprint: string;
  appVersion: string;
  friendRequests: FriendRequest[];
  voiceCallActive: boolean;
  voiceCallRoomId: string | null;
  voiceCallPeerId: string | null;
  voiceCallPeerName: string;
  voiceCallIncoming: boolean;
  voiceCallHostId: string | null;
  voiceCallParticipants: VoiceCallParticipant[];
  voiceCallTargets: VoiceCallTarget[];

  setView: (v: AppView) => void;
  setNavSection: (s: NavSection) => void;
  setActiveConvId: (id: string | null) => void;
  loadConversations: () => Promise<void>;
  loadMessages: (convId: string) => Promise<void>;
  loadDevices: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadFriendRequests: () => Promise<void>;
  setLocked: (v: boolean) => void;
  setNetworkActive: (v: boolean) => void;
  setVoiceCall: (s: Partial<{ active: boolean; roomId: string | null; peerId: string | null; peerName: string; incoming: boolean; hostId: string | null; participants: VoiceCallParticipant[]; targets: VoiceCallTarget[] }>) => void;
  appendMessage: (convId: string, msg: ChatMessage) => void;
  updateMessageInStore: (convId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  removeMessage: (convId: string, messageId: string) => void;
  init: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  setup: (password: string, deviceName: string) => Promise<boolean>;
  lock: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setupEventListeners: () => Promise<() => void>;
}

const defaultSettings: AppSettings = {
  lock_timeout_minutes: 15,
  clipboard_clear_seconds: 30,
  blur_on_focus_loss: false,
  lock_on_sleep: true,
  auto_backup_enabled: true,
  auto_backup_interval_hours: 24,
  auto_backup_max: 7,
  burn_after_read_delay: 10,
  network_port: 48443,
  self_destruct_enabled: false,
  theme: "dark",
  pet_enabled: true,
  pet_x: -1,
  pet_y: -1,
};

let clipboardTimer: ReturnType<typeof setInterval> | null = null;

export const useStore = create<AppState>((set, get) => ({
  view: "unlock",
  navSection: "chats",
  conversations: [],
  activeConvId: null,
  messages: {},
  devices: [],
  settings: defaultSettings,
  locked: false,
  deviceId: null,
  deviceName: null,
  networkActive: false,
  localIps: [],
  pairingCode: "",
  fingerprint: "",
  appVersion: "",
  friendRequests: [],
  voiceCallActive: false,
  voiceCallRoomId: null,
  voiceCallPeerId: null,
  voiceCallPeerName: "",
  voiceCallIncoming: false,
  voiceCallHostId: null,
  voiceCallParticipants: [],
  voiceCallTargets: [],

  setView: (v) => set({ view: v }),
  setNavSection: (s) => set({ navSection: s }),
  setActiveConvId: (id) => set({ activeConvId: id }),

  loadConversations: async () => {
    try {
      const convs = await api.getConversations();
      set({ conversations: convs });
    } catch (e) { console.error("loadConversations:", e); }
  },

  loadMessages: async (convId) => {
    try {
      const msgs = await api.getMessages(convId, 200, 0);
      set((state) => ({ messages: { ...state.messages, [convId]: msgs } }));
    } catch (e) { console.error("loadMessages:", e); }
  },

  loadDevices: async () => {
    try {
      const devs = await api.getDevices();
      set({ devices: devs });
    } catch (e) { console.error("loadDevices:", e); }
  },

  loadSettings: async () => {
    try {
      const s = await api.getAllSettings();
      const merged = { ...defaultSettings, ...s } as AppSettings;
      // pet position is persisted as string by the backend settings store
      merged.pet_x = typeof merged.pet_x === "string" ? (parseInt(merged.pet_x, 10) || -1) : merged.pet_x;
      merged.pet_y = typeof merged.pet_y === "string" ? (parseInt(merged.pet_y, 10) || -1) : merged.pet_y;
      set({ settings: merged });
    } catch (e) { console.error("loadSettings:", e); }
  },

  loadFriendRequests: async () => {
    try {
      const reqs = await api.getFriendRequests();
      set({ friendRequests: reqs });
    } catch (e) { console.error("loadFriendRequests:", e); }
  },

  setLocked: (v) => set({ locked: v, view: v ? "locked" : "main" }),
  setNetworkActive: (v) => set({ networkActive: v }),
  setVoiceCall: (s) => set((state) => ({
    voiceCallActive: s.active ?? state.voiceCallActive,
    voiceCallRoomId: s.roomId !== undefined ? s.roomId : state.voiceCallRoomId,
    voiceCallPeerId: s.peerId !== undefined ? s.peerId : state.voiceCallPeerId,
    voiceCallPeerName: s.peerName ?? state.voiceCallPeerName,
    voiceCallIncoming: s.incoming ?? state.voiceCallIncoming,
    voiceCallHostId: s.hostId !== undefined ? s.hostId : state.voiceCallHostId,
    voiceCallParticipants: s.participants !== undefined ? s.participants : state.voiceCallParticipants,
    voiceCallTargets: s.targets !== undefined ? s.targets : state.voiceCallTargets,
  })),

  appendMessage: (convId, msg) =>
    set((state) => ({
      messages: { ...state.messages, [convId]: [...(state.messages[convId] || []), msg] },
    })),

  updateMessageInStore: (convId, messageId, updates) =>
    set((state) => {
      const msgs = state.messages[convId] || [];
      return {
        messages: {
          ...state.messages,
          [convId]: msgs.map((m) => (m.message_id === messageId ? { ...m, ...updates } : m)),
        },
      };
    }),

  removeMessage: (convId, messageId) =>
    set((state) => {
      const msgs = state.messages[convId] || [];
      return {
        messages: { ...state.messages, [convId]: msgs.filter((m) => m.message_id !== messageId) },
      };
    }),

  init: async () => {
    try {
      const exists = await api.vaultExists();
      if (!exists) { set({ view: "setup" }); return; }
      const unlocked = await api.isUnlocked();
      set({ view: unlocked ? "main" : "unlock" });
    } catch { set({ view: "setup" }); }
  },

  unlock: async (password) => {
    try {
      if (get().view === "locked") {
        const alreadyUnlocked = await api.isUnlocked();
        if (alreadyUnlocked) {
          set({ view: "main", locked: false });
          return true;
        }
      }
      await api.unlockVault(password);
      const did = await api.getDeviceId();
      let dname = "Unknown";
      try { dname = await api.getDeviceName(); } catch {}
      const ver = await api.getAppVersion();
      set({ view: "main", deviceId: did, deviceName: dname, locked: false, appVersion: ver });
      await get().refreshAll();
      try {
        const info = await api.startNetwork(dname);
        set({ networkActive: true, localIps: info.local_ips, fingerprint: info.fingerprint });
      } catch (e) { console.error("startNetwork:", e); }
      await get().loadFriendRequests();
      return true;
    } catch (e) {
      console.error("unlock:", e);
      throw e;
    }
  },

  setup: async (password, deviceName) => {
    try {
      const did = await api.createVault(password, deviceName);
      const ver = await api.getAppVersion();
      set({ view: "main", deviceId: did, deviceName, locked: false, appVersion: ver });
      await get().refreshAll();
      try {
        const info = await api.startNetwork(deviceName);
        set({ networkActive: true, localIps: info.local_ips, fingerprint: info.fingerprint });
      } catch (e) { console.error("startNetwork:", e); }
      return true;
    } catch (e) {
      console.error("setup:", e);
      throw e;
    }
  },

  lock: async () => {
    try { await api.lockVault(); } catch {}
    set({ locked: true, view: "locked" });
  },

  refreshAll: async () => {
    await Promise.all([get().loadConversations(), get().loadDevices(), get().loadSettings(), get().loadFriendRequests()]);
  },

  setupEventListeners: async () => {
    const unlisteners: UnlistenFn[] = [];

    unlisteners.push(
      await listen<{ conversation_id: string }>("message-received", async (event) => {
        const convId = event.payload.conversation_id;
        const state = get();
        await state.loadConversations();
        if (state.activeConvId === convId) {
          await state.loadMessages(convId);
          await api.resetUnread(convId);
        }
      }),
    );

    unlisteners.push(
      await listen<Device>("device-added", async () => {
        await get().loadDevices();
        await get().loadConversations();
      }),
    );

    unlisteners.push(
      await listen("file-received", async () => {
        const convId = get().activeConvId;
        if (convId) { await get().loadMessages(convId); }
      }),
    );

    unlisteners.push(
      await listen<{ message_id: string; status: string }>("message-ack", (event) => {
        const { message_id, status } = event.payload;
        const state = get();
        for (const [convId, msgs] of Object.entries(state.messages)) {
          if (msgs.find((m) => m.message_id === message_id)) {
            state.updateMessageInStore(convId, message_id, { status: status as ChatMessage["status"] });
            break;
          }
        }
      }),
    );

    // Friend request events
    unlisteners.push(
      await listen("friend-request-received", async () => {
        await get().loadFriendRequests();
      }),
    );
    unlisteners.push(
      await listen("friend-request-accepted", async () => {
        await get().loadDevices();
        await get().loadConversations();
      }),
    );
    unlisteners.push(
      await listen("friend-request-rejected", async () => {
        await get().loadFriendRequests();
      }),
    );

    // Profile update
    unlisteners.push(
      await listen<{ device_id: string; display_name: string }>("profile-update", async () => {
        await get().loadDevices();
        await get().loadConversations();
      }),
    );

    // Voice call events (v1.4: room-based multi-party)
    unlisteners.push(
      await listen<{ sender_id: string; sender_name: string; room_id: string }>("voice-call-invite", (event) => {
        get().setVoiceCall({
          active: true, incoming: true, roomId: event.payload.room_id,
          peerId: event.payload.sender_id, peerName: event.payload.sender_name,
          hostId: event.payload.sender_id, participants: [], targets: [],
        });
      }),
    );
    unlisteners.push(
      await listen<{ room_id: string; participants: string[]; names: string[] }>("voice-call-participants", (event) => {
        if (event.payload.room_id !== get().voiceCallRoomId) return;
        const participants: VoiceCallParticipant[] = event.payload.participants.map((device_id, i) => ({
          device_id,
          name: event.payload.names[i] || device_id.slice(0, 8),
        }));
        get().setVoiceCall({ participants });
      }),
    );
    unlisteners.push(
      await listen<{ responder_id: string; room_id: string; accepted: boolean }>("voice-call-response", (event) => {
        if (!event.payload.accepted) {
          get().setVoiceCall({ active: false, roomId: null, peerId: null, peerName: "", incoming: false, hostId: null, participants: [], targets: [] });
        }
      }),
    );
    unlisteners.push(
      await listen("voice-call-end", () => {
        get().setVoiceCall({ active: false, roomId: null, peerId: null, peerName: "", incoming: false, hostId: null, participants: [], targets: [] });
      }),
    );

    return () => { unlisteners.forEach((u) => u()); };
  },
}));

export function startClipboardClearLoop() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = setInterval(async () => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText("");
    } catch { /* best-effort */ }
  }, 30000);
}
