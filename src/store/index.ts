import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  updateMessageInStore: (
    convId: string,
    messageId: string,
    updates: Partial<ChatMessage>,
  ) => void;
  removeMessage: (convId: string, messageId: string) => void;
  init: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  setup: (password: string, deviceName: string) => Promise<boolean>;
  lock: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setupEventListeners: () => Promise<() => void>;
  setupAutoLock: () => void;
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

let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
let clipboardTimer: ReturnType<typeof setTimeout> | null = null;

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
      get().setupAutoLock();
      return true;
    } catch (e) {
      console.error("unlock:", e);
      throw e;
    }
  },

  setup: async (password, deviceName) => {
    try {
      const did = await api.createVault(password, deviceName);
      set({ view: "main", deviceId: did, deviceName, locked: false });
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
      get().setupAutoLock();
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

  setupEventListeners: async () => {
    const unlisteners: UnlistenFn[] = [];

    // Incoming message: reload messages and conversations
    unlisteners.push(
      await listen<{ conversation_id: string }>("message-received", async (event) => {
        const convId = event.payload.conversation_id;
        const state = get();
        // Reload conversations to update last message / unread
        await state.loadConversations();
        // If this conversation is active, reload its messages
        if (state.activeConvId === convId) {
          await state.loadMessages(convId);
          await api.resetUnread(convId);
        }
      }),
    );

    // New device discovered/added
    unlisteners.push(
      await listen<Device>("device-added", async () => {
        await get().loadDevices();
        await get().loadConversations();
      }),
    );

    // File received: reload active conversation messages
    unlisteners.push(
      await listen("file-received", async () => {
        const convId = get().activeConvId;
        if (convId) {
          await get().loadMessages(convId);
        }
      }),
    );

    // Message ack (delivery confirmation)
    unlisteners.push(
      await listen<{ message_id: string; status: string }>("message-ack", (event) => {
        const { message_id, status } = event.payload;
        const state = get();
        for (const [convId, msgs] of Object.entries(state.messages)) {
          const msg = msgs.find((m) => m.message_id === message_id);
          if (msg) {
            state.updateMessageInStore(convId, message_id, { status: status as ChatMessage["status"] });
            break;
          }
        }
      }),
    );

    // Window blur: start auto-lock timer
    unlisteners.push(
      await listen("window-blur", () => {
        get().setupAutoLock();
      }),
    );

    return () => {
      unlisteners.forEach((u) => u());
    };
  },

  setupAutoLock: () => {
    const { settings, view } = get();
    if (view !== "main") return;

    // Clear existing timer
    if (autoLockTimer) {
      clearTimeout(autoLockTimer);
      autoLockTimer = null;
    }

    const timeoutMs = settings.lock_timeout_minutes * 60 * 1000;
    if (timeoutMs > 0) {
      autoLockTimer = setTimeout(() => {
        get().lock();
      }, timeoutMs);
    }
  },
}));

// Clipboard auto-clear: periodically clears clipboard after the configured interval
export function startClipboardClearLoop() {
  if (clipboardTimer) clearInterval(clipboardTimer);

  clipboardTimer = setInterval(async () => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText("");
    } catch {
      // Clipboard clearing is best-effort
    }
  }, 30000); // Check every 30s
}
