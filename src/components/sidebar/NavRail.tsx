import {
  MessageSquare,
  Users,
  Settings,
  Lock,
  HardDrive,
  Wifi,
} from "lucide-react";
import { useStore } from "../../store";
import type { NavSection } from "../../types";

export default function NavRail() {
  const navSection = useStore((s) => s.navSection);
  const setNavSection = useStore((s) => s.setNavSection);
  const networkActive = useStore((s) => s.networkActive);
  const lock = useStore((s) => s.lock);
  const deviceName = useStore((s) => s.deviceName);

  const items: { key: NavSection; icon: typeof MessageSquare; label: string }[] = [
    { key: "chats", icon: MessageSquare, label: "聊天" },
    { key: "contacts", icon: Users, label: "联系人" },
    { key: "files", icon: HardDrive, label: "备份" },
    { key: "settings", icon: Settings, label: "设置" },
  ];

  return (
    <div className="w-16 pl-glass border-r border-white/5 flex flex-col items-center py-4 flex-shrink-0">
      {items.map(({ key, icon: Icon, label }) => (
        <button
          key={key}
          onClick={() => setNavSection(key)}
          className={`group relative w-11 h-11 rounded-xl flex items-center justify-center mb-2 transition-all ${
            navSection === key
              ? "pl-glow-cyan-sm bg-cyan-500/10"
              : "hover:bg-white/5"
          }`}
          title={label}
        >
          <Icon
            size={20}
            className={navSection === key ? "pl-text-cyan" : "pl-text-dim"}
          />
          <span className="absolute left-14 px-2 py-1 rounded pl-glass-strong text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            {label}
          </span>
        </button>
      ))}

      <div className="flex-1" />

      {/* Network status */}
      <div className="mb-3 flex flex-col items-center" title={networkActive ? "局域网在线" : "离线"}>
        <div className="relative">
          <Wifi
            size={18}
            className={networkActive ? "pl-text-green" : "pl-text-dim"}
          />
          {networkActive && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-400 pl-online-dot" />
          )}
        </div>
      </div>

      {/* Device avatar */}
      <div
        className="w-10 h-10 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-xs pl-text-cyan font-medium mb-2"
        title={deviceName || ""}
      >
        {(deviceName || "?").charAt(0).toUpperCase()}
      </div>

      {/* Lock button */}
      <button
        onClick={lock}
        className="w-11 h-11 rounded-xl flex items-center justify-center hover:bg-red-500/10 transition-all"
        title="锁定"
      >
        <Lock size={18} className="pl-text-dim hover:text-red-400" />
      </button>
    </div>
  );
}
