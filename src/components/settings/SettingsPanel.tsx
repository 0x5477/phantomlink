import { useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
 import { Shield, Clipboard, Database, Wifi, Lock } from "lucide-react";

export default function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
 const deviceId = useStore((s) => s.deviceId);
 const localIps = useStore((s) => s.localIps);
  const fingerprint = useStore((s) => s.fingerprint);
  const [saved, setSaved] = useState(false);

  const updateSetting = async (key: string, value: string) => {
    await api.setSetting(key, value);
    await loadSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-medium pl-text-cyan mb-6 flex items-center gap-2">
        <Shield size={20} />
        设置
      </h1>

      {saved && (
        <div className="pl-glass pl-glow-green rounded-lg px-4 py-2 mb-4 text-sm pl-text-green pl-fade-in">
          已保存
        </div>
      )}

      {/* Security section */}
      <Section title="安全" icon={Lock}>
        <Row label="空闲自动锁屏" desc="无操作后自动锁定（分钟）">
          <input
            type="number"
            min={1}
            max={60}
            value={settings.lock_timeout_minutes}
            onChange={(e) => updateSetting("lock_timeout_minutes", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center"
          />
        </Row>
        <Row label="失焦模糊" desc="窗口失去焦点时模糊内容">
          <Toggle
            checked={settings.blur_on_focus_loss}
            onChange={(v) => updateSetting("blur_on_focus_loss", String(v))}
          />
        </Row>
        <Row label="睡眠锁屏" desc="系统进入睡眠时自动锁定">
          <Toggle
            checked={settings.lock_on_sleep}
            onChange={(v) => updateSetting("lock_on_sleep", String(v))}
          />
        </Row>
        <Row label="阅后即焚延迟" desc="阅读后销毁倒计时（秒）">
          <input
            type="number"
            min={3}
            max={60}
            value={settings.burn_after_read_delay}
            onChange={(e) => updateSetting("burn_after_read_delay", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center"
          />
        </Row>
      </Section>

      {/* Clipboard section */}
      <Section title="剪贴板" icon={Clipboard}>
        <Row label="自动清除延迟" desc="复制后自动清空剪贴板（秒）">
          <input
            type="number"
            min={5}
            max={120}
            value={settings.clipboard_clear_seconds}
            onChange={(e) => updateSetting("clipboard_clear_seconds", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center"
          />
        </Row>
      </Section>

      {/* Backup section */}
      <Section title="自动备份" icon={Database}>
        <Row label="启用自动备份" desc="定期自动加密备份聊天记录">
          <Toggle
            checked={settings.auto_backup_enabled}
            onChange={(v) => updateSetting("auto_backup_enabled", String(v))}
          />
        </Row>
        <Row label="备份周期" desc="自动备份间隔（小时）">
          <input
            type="number"
            min={1}
            max={168}
            value={settings.auto_backup_interval_hours}
            onChange={(e) => updateSetting("auto_backup_interval_hours", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center"
          />
        </Row>
        <Row label="最大保留份数" desc="滚动保留的备份数量">
          <input
            type="number"
            min={1}
            max={30}
            value={settings.auto_backup_max}
            onChange={(e) => updateSetting("auto_backup_max", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center"
          />
        </Row>
      </Section>

      {/* Network section */}
      <Section title="网络" icon={Wifi}>
        <Row label="监听端口" desc="P2P 连接监听端口">
          <input
            type="number"
            min={1024}
            max={65535}
            value={settings.network_port}
            onChange={(e) => updateSetting("network_port", e.target.value)}
            className="pl-input w-24 px-3 py-1.5 text-sm text-center"
          />
        </Row>
        <div className="pl-glass rounded-lg p-3 mt-2">
          <p className="text-xs pl-text-dim mb-1">本机 IP</p>
          <p className="text-xs pl-text-cyan font-mono">
            {localIps.join(", ") || "未检测到"}
          </p>
          <p className="text-xs pl-text-dim mt-2 mb-1">设备 ID</p>
          <p className="text-xs font-mono break-all">{deviceId}</p>
          <p className="text-xs pl-text-dim mt-2 mb-1">指纹</p>
          <p className="text-xs font-mono pl-text-cyan break-all">{fingerprint}</p>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Shield;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-sm pl-text-dim flex items-center gap-2 mb-3 px-1">
        <Icon size={14} />
        {title}
      </h2>
      <div className="pl-glass rounded-xl overflow-hidden">{children}</div>
    </div>
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/3 last:border-0">
      <div>
        <p className="text-sm">{label}</p>
        <p className="text-xs pl-text-dim">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full transition-all relative ${
        checked
          ? "bg-cyan-500/30 border border-cyan-400/40"
          : "bg-white/5 border border-white/10"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
          checked ? "left-5 bg-cyan-400 pl-glow-cyan-sm" : "left-0.5 bg-gray-500"
        }`}
      />
    </button>
  );
}
