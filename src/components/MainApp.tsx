import { useEffect } from "react";
import { useStore, startClipboardClearLoop } from "../store";
import NavRail from "./sidebar/NavRail";
import ConversationList from "./sidebar/ConversationList";
import DeviceList from "./sidebar/DeviceList";
import ChatWindow from "./chat/ChatWindow";
import SettingsPanel from "./settings/SettingsPanel";
import BackupPanel from "./backup/BackupPanel";
import MaidPet from "./pet/MaidPet";

export default function MainApp() {
  const navSection = useStore((s) => s.navSection);
  const activeConvId = useStore((s) => s.activeConvId);
  const refreshAll = useStore((s) => s.refreshAll);
  const loadMessages = useStore((s) => s.loadMessages);
  const deviceName = useStore((s) => s.deviceName);
  const setupEventListeners = useStore((s) => s.setupEventListeners);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    setupEventListeners().then((fn) => { cleanup = fn; });
    startClipboardClearLoop();
    return () => { cleanup?.(); };
  }, [setupEventListeners]);

  useEffect(() => {
    if (activeConvId) { loadMessages(activeConvId); }
  }, [activeConvId, loadMessages]);

  const showSidebar = () => {
    if (navSection === "chats") return <ConversationList />;
    if (navSection === "contacts") return <DeviceList />;
    return null;
  };

  const showMain = () => {
    if (navSection === "settings") return <SettingsPanel />;
    if (navSection === "files") return <BackupPanel />;
    if (activeConvId) return <ChatWindow convId={activeConvId} />;
    return <EmptyState deviceName={deviceName} />;
  };

  return (
    <>
      <div className="flex h-full">
        <NavRail />
        {showSidebar() && (
          <div className="w-72 pl-glass border-r border-white/5 flex-shrink-0 flex flex-col">
            {showSidebar()}
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0">{showMain()}</div>
      </div>
      <MaidPet />
    </>
  );
}

function EmptyState({ deviceName }: { deviceName: string | null }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center pl-text-dim">
      <div className="w-24 h-24 rounded-full pl-glass pl-glow-cyan flex items-center justify-center mb-6">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
            stroke="currentColor" strokeWidth="1.5" className="pl-text-cyan" />
        </svg>
      </div>
      <h2 className="text-lg pl-text-cyan mb-2">PhantomLink</h2>
      <p className="text-sm">{deviceName ? `欢迎回来，${deviceName}` : "选择一个会话或联系人开始聊天"}</p>
      <p className="text-xs mt-4 opacity-60">所有通信均经过端到端加密</p>
    </div>
  );
}
