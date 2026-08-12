import { create } from "zustand";
import type {
  AppView,
  AppSettings,
  ChatMessage,
  Conversation,
  Device,
  NavSection,
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

  setView: (v: AppView) => void;
  setNavSection: (s: NavSection) => void;
  setActiveConvId: (id: string | null) => void;
  loadConversations: () => Promise<void>;
  loadMessages: (convId: string) => Promise<void>;
  loadDevices: () => Promise<void>;
  loadSettings: () => Promise<void>;
  setLocked: (v: boolean) => void;
  setNetworkActive: (v: boolean) => void;
  appendMessage: (convId: string, msg: ChatMessage) => void;
  updateMessageInStore: (convId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  removeMessage: (convId: string, messageId: string) => void;
  init: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  setup: (password: string, deviceName: string) => Promise<boolean>;
  lock: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

const defaultSettings: AppSettings = {
  lock_timeout_minutes: 5,
  clipboard_clear_seconds: 30,
  blur_on_focus_loss: true,
  lock_on_sleep: true,
  auto_backup_enabled: true,
  auto_backup_interval_hours: 24,
  auto_backup_max: 7,
  burn_after_read_delay: 10,
  network_port: 48443,
};

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

  setView: (v) => set({ view: v }),
  setNavSection: (s) => set({ navSection: s }),
  setActiveConvId: (id) => set({ activeConvId: id }),

  loadConversations: async () => {
    try {
      const convs = await api.getConversations();
      set({ conversations: convs });
    } catch (e) {
      console.error("loadConversations:", e);
    }
  },

  loadMessages: async (convId) => {
    try {
      const msgs = await api.getMessages(convId, 200, 0);
      set((state) => ({
        messages: { ...state.messages, [convId]: msgs },
      }));
    } catch (e) {
      console.error("loadMessages:", e);
    }
  },

  loadDevices: async () => {
    try {
      const devs = await api.getDevices();
      set({ devices: devs });
    } catch (e) {
      console.error("loadDevices:", e);
    }
  },

  loadSettings: async () => {
    try {
      const s = await api.getAllSettings();
      set({ settings: { ...defaultSettings, ...s } });
    } catch (e) {
      console.error("loadSettings:", e);
    }
  },

  setLocked: (v) => set({ locked: v, view: v ? "locked" : "main" }),
  setNetworkActive: (v) => set({ networkActive: v }),

  appendMessage: (convId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [convId]: [...(state.messages[convId] || []), msg],
      },
    })),

  updateMessageInStore: (convId, messageId, updates) =>
    set((state) => {
      const msgs = state.messages[convId] || [];
      return {
        messages: {
          ...state.messages,
          [convId]: msgs.map((m) =>
            m.message_id === messageId ? { ...m, ...updates } : m,
          ),
        },
      };
    }),

  removeMessage: (convId, messageId) =>
    set((state) => {
      const msgs = state.messages[convId] || [];
      return {
        messages: {
          ...state.messages,
          [convId]: msgs.filter((m) => m.message_id !== messageId),
        },
      };
    }),

  init: async () => {
    try {
      const exists = await api.vaultExists();
      if (!exists) {
        set({ view: "setup" });
        return;
      }
      const unlocked = await api.isUnlocked();
      set({ view: unlocked ? "main" : "unlock" });
    } catch {
      set({ view: "setup" });
    }
  },

  unlock: async (password) => {
    try {
      await api.unlockVault(password);
      const did = await api.getDeviceId();
      let dname = "Unknown";
      try {
        dname = await api.getDeviceName();
      } catch {}
      set({ view: "main", deviceId: did, deviceName: dname, locked: false });
      await get().refreshAll();
      // Start network
      try {
        const info = await api.startNetwork(dname);
        set({
          networkActive: true,
          localIps: info.local_ips,
          fingerprint: info.fingerprint,
        });
      } catch (e) {
        console.error("startNetwork:", e);
      }
      return true;
    } catch (e) {
      console.error("unlock:", e);
      throw e;
    }
  },

  setup: async (password, deviceName) => {
    try {
      const did = await api.createVault(password, deviceName);
      set({
        view: "main",
        deviceId: did,
        deviceName,
        locked: false,
      });
      await get().refreshAll();
      try {
        const info = await api.startNetwork(deviceName);
        set({
          networkActive: true,
          localIps: info.local_ips,
          fingerprint: info.fingerprint,
        });
      } catch (e) {
        console.error("startNetwork:", e);
      }
      return true;
    } catch (e) {
      console.error("setup:", e);
      throw e;
    }
  },

  lock: async () => {
    try {
      await api.lockVault();
      await api.stopNetwork();
    } catch {}
    set({ locked: true, view: "locked", networkActive: false });
  },

  refreshAll: async () => {
    await Promise.all([
      get().loadConversations(),
      get().loadDevices(),
      get().loadSettings(),
    ]);
  },
}));
