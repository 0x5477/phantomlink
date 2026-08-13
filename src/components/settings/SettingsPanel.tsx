import { useState, useRef } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import {
  Shield, Clipboard, Database, Wifi, Lock, Info, Sun, Moon,
  Skull, AlertTriangle, CheckCircle, Trash2, User, Camera, Sparkles,
} from "lucide-react";

export default function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const deviceId = useStore((s) => s.deviceId);
  const localIps = useStore((s) => s.localIps);
  const fingerprint = useStore((s) => s.fingerprint);
  const appVersion = useStore((s) => s.appVersion);
  const deviceName = useStore((s) => s.deviceName);
  const [saved, setSaved] = useState(false);
  const [showSelfDestruct, setShowSelfDestruct] = useState(false);
  const [destructConfirm, setDestructConfirm] = useState("");
  const [destructing, setDestructing] = useState(false);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "latest" | "available" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState<{ tag: string; name: string; url: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState("");

  // Profile editing
  const [editName, setEditName] = useState(deviceName || "");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const updateSetting = async (key: string, value: string) => {
    await api.setSetting(key, value);
    await loadSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleSelfDestruct = async () => {
    if (destructConfirm !== "确认自毁") return;
    setDestructing(true);
    try {
      await api.selfDestruct();
    } catch (e) {
      console.error("self destruct:", e);
    }
    setTimeout(() => {
      try { window.close(); } catch {}
      try { window.location.reload(); } catch {}
    }, 500);
  };

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert("头像不能超过2MB"); return; }
   const reader = new FileReader();
   reader.onload = () => {
     const result = reader.result as string;
     setAvatarPreview(result);
   };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleSaveProfile = async () => {
    try {
      await api.updateProfile(editName || null, avatarPreview ? avatarPreview.split(",")[1] : null);
      useStore.setState({ deviceName: editName });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 1500);
      setAvatarPreview(null);
    } catch (e) {
      console.error("update profile:", e);
      alert("保存失败: " + e);
    }
  };

  // ---- Update check / download from GitHub ----
  const GH_REPO = "0x5477/phantomlink";

  const cmpVersion = (a: string, b: string): number => {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  };

  const pickAsset = (assets: { name: string; browser_download_url: string }[]) => {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
    if (isMac) {
      return assets.find((a) => a.name.includes("aarch64") && a.name.endsWith(".dmg"))
        || assets.find((a) => a.name.endsWith(".dmg"));
    }
    return assets.find((a) => a.name.endsWith(".exe"))
      || assets.find((a) => a.name.endsWith(".msi"))
      || assets[0];
  };

  const handleCheckUpdate = async () => {
    setUpdateState("checking");
    setDownloadMsg("");
    try {
      const rel = await api.checkLatestRelease();
      const tag = String(rel.tag_name || "").replace(/^v/, "");
      const cur = String(appVersion || "1.5.0").replace(/^v/, "");
      setUpdateInfo({ tag: rel.tag_name || tag, name: rel.name || "", url: rel.html_url || `https://github.com/${GH_REPO}/releases` });
      setUpdateState(cmpVersion(tag, cur) > 0 ? "available" : "latest");
    } catch (e) {
      console.error("check update:", e);
      setUpdateState("error");
    }
  };

  const handleDownloadUpdate = async () => {
    if (!updateInfo) return;
    setDownloading(true);
    setDownloadMsg("");
    try {
      const rel = await api.checkLatestRelease();
      const asset = pickAsset(rel.assets || []);
      if (!asset) throw new Error("no asset for this platform");
      // Backend downloads from GitHub (follows redirects, no CORS issues)
      const path = await api.downloadReleaseAsset(asset.browser_download_url, asset.name);
      setDownloadMsg(`已下载到：${path}`);
      try {
        const { openPath } = await import("@tauri-apps/plugin-opener");
        await openPath(path); // open/install the downloaded package
      } catch {
        alert(`新版本安装包已下载到：
${path}`);
      }
    } catch (e) {
      console.error("download update:", e);
      setDownloadMsg("自动下载失败，已打开 Release 页面");
      if (updateInfo.url) window.open(updateInfo.url, "_blank");
    }
    setDownloading(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-medium pl-text-cyan mb-6 flex items-center gap-2">
        <Shield size={20} />
        设置
      </h1>

      {saved && (
        <div className="pl-glass pl-glow-green rounded-lg px-4 py-2 mb-4 text-sm pl-text-green pl-fade-in flex items-center gap-2">
          <CheckCircle size={14} />
          已保存
        </div>
      )}

      {/* Profile */}
      <Section title="个人资料" icon={User}>
        <div className="px-4 py-4">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-full pl-glass pl-glow-cyan flex items-center justify-center text-xl pl-text-cyan font-medium overflow-hidden">
              {avatarPreview ? <img src={avatarPreview} alt="avatar" className="w-full h-full object-cover" /> : (deviceName || "?").charAt(0).toUpperCase()}
            </div>
            <button onClick={() => avatarInputRef.current?.click()} className="pl-btn-ghost rounded-lg px-3 py-2 text-xs flex items-center gap-1.5">
              <Camera size={14} /> 更换头像
            </button>
            <input ref={avatarInputRef} type="file" className="hidden" accept="image/png,image/jpeg" onChange={handleAvatarSelect} />
          </div>
          <div className="mb-3">
            <label className="text-xs pl-text-dim block mb-1">昵称</label>
            <input className="pl-input w-full px-3 py-2 text-sm" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="输入新昵称" />
          </div>
          {profileSaved && <p className="text-xs text-green-400 mb-2">资料已保存</p>}
          <button onClick={handleSaveProfile} className="pl-btn-primary rounded-lg px-4 py-2 text-sm">保存资料</button>
        </div>
      </Section>

      {/* Appearance */}
      <Section title="外观" icon={settings.theme === "dark" ? Moon : Sun}>
        <Row label="主题模式" desc="切换日间/夜间主题">
          <div className="flex gap-1 pl-glass rounded-lg p-1">
            <button onClick={() => updateSetting("theme", "light")}
              className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-all ${settings.theme === "light" ? "bg-cyan-500/20 pl-text-cyan" : "pl-text-dim"}`}>
              <Sun size={14} /> 日间
            </button>
            <button onClick={() => updateSetting("theme", "dark")}
              className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-all ${settings.theme === "dark" ? "bg-cyan-500/20 pl-text-cyan" : "pl-text-dim"}`}>
              <Moon size={14} /> 夜间
            </button>
          </div>
        </Row>
      </Section>

      {/* Pet */}
      <Section title="桌面宠物" icon={Sparkles}>
        <Row label="显示桌面宠物" desc="右下角的《工作细胞》风格小助手，可拖动位置">
          <Toggle checked={settings.pet_enabled} onChange={(v) => updateSetting("pet_enabled", String(v))} />
        </Row>
      </Section>

      {/* Security */}
      <Section title="安全" icon={Lock}>
        <Row label="空闲自动锁屏" desc="无操作后自动锁定（分钟，0=不自动锁屏）">
          <input type="number" min={0} max={120} value={settings.lock_timeout_minutes}
            onChange={(e) => updateSetting("lock_timeout_minutes", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center" />
        </Row>
        <Row label="阅后即焚延迟" desc="阅读后销毁倒计时（秒）">
          <input type="number" min={3} max={60} value={settings.burn_after_read_delay}
            onChange={(e) => updateSetting("burn_after_read_delay", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center" />
        </Row>
      </Section>

      {/* Self-destruct */}
      <Section title="数据自毁" icon={Skull}>
        <Row label="自动自毁保护" desc="检测到5次恶意破解尝试后自动销毁全部数据">
          <Toggle checked={settings.self_destruct_enabled} onChange={(v) => updateSetting("self_destruct_enabled", String(v))} />
        </Row>
        <div className="px-4 py-3 border-b border-white/3 last:border-0">
          <button onClick={() => setShowSelfDestruct(true)}
            className="w-full py-2.5 rounded-lg text-sm bg-red-500/10 border border-red-400/30 text-red-400 flex items-center justify-center gap-2 hover:bg-red-500/20 transition-all">
            <Trash2 size={16} />
            立即自毁
          </button>
          <p className="text-xs pl-text-dim mt-2 text-center">点击后将立即不可逆清除所有加密数据</p>
        </div>
      </Section>

      {/* Clipboard */}
      <Section title="剪贴板" icon={Clipboard}>
        <Row label="自动清除延迟" desc="复制后自动清空剪贴板（秒）">
          <input type="number" min={5} max={120} value={settings.clipboard_clear_seconds}
            onChange={(e) => updateSetting("clipboard_clear_seconds", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center" />
        </Row>
      </Section>

      {/* Backup */}
      <Section title="自动备份" icon={Database}>
        <Row label="启用自动备份" desc="定期自动加密备份聊天记录">
          <Toggle checked={settings.auto_backup_enabled} onChange={(v) => updateSetting("auto_backup_enabled", String(v))} />
        </Row>
        <Row label="备份周期" desc="自动备份间隔（小时）">
          <input type="number" min={1} max={168} value={settings.auto_backup_interval_hours}
            onChange={(e) => updateSetting("auto_backup_interval_hours", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center" />
        </Row>
        <Row label="最大保留份数" desc="滚动保留的备份数量">
          <input type="number" min={1} max={30} value={settings.auto_backup_max}
            onChange={(e) => updateSetting("auto_backup_max", e.target.value)}
            className="pl-input w-20 px-3 py-1.5 text-sm text-center" />
        </Row>
      </Section>

      {/* Network */}
      <Section title="网络" icon={Wifi}>
        <Row label="监听端口" desc="P2P 连接监听端口">
          <input type="number" min={1024} max={65535} value={settings.network_port}
            onChange={(e) => updateSetting("network_port", e.target.value)}
            className="pl-input w-24 px-3 py-1.5 text-sm text-center" />
        </Row>
        <div className="pl-glass rounded-lg p-3 mt-2">
          <p className="text-xs pl-text-dim mb-1">本机 IP</p>
          <p className="text-xs pl-text-cyan font-mono">{localIps.join(", ") || "未检测到"}</p>
          <p className="text-xs pl-text-dim mt-2 mb-1">设备 ID</p>
          <p className="text-xs font-mono break-all">{deviceId}</p>
          <p className="text-xs pl-text-dim mt-2 mb-1">指纹</p>
          <p className="text-xs font-mono pl-text-cyan break-all">{fingerprint}</p>
        </div>
      </Section>

      {/* About */}
      <Section title="关于 PhantomLink" icon={Info}>
        <div className="px-4 py-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl pl-glass pl-glow-cyan flex items-center justify-center">
              <Shield size={24} className="pl-text-cyan" />
            </div>
            <div>
              <h3 className="text-sm font-medium">PhantomLink 幻链</h3>
              <p className="text-xs pl-text-dim">局域网加密通讯工具</p>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="pl-text-dim">当前版本</span>
              <span className="font-mono pl-text-cyan">v{appVersion || "1.5.0"}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="pl-text-dim">加密方案</span>
              <span className="font-mono">AES-256-GCM + Argon2id</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="pl-text-dim">网络模式</span>
              <span className="font-mono">LAN P2P (mDNS)</span>
            </div>
          </div>
                    <div className="mt-3 pl-glass rounded-lg p-3 text-xs">
            {updateState === "checking" && <p className="pl-text-dim">正在检查更新...</p>}
            {updateState === "latest" && <p className="pl-text-green">✓ 已是最新版本（{updateInfo?.tag || ""}）</p>}
            {updateState === "available" && <p className="text-cyan-400">★ 发现新版本 {updateInfo?.tag || ""}，点击下方"立即更新"下载</p>}
            {updateState === "error" && <p className="text-red-400">检查更新失败，请检查网络后重试</p>}
            {downloadMsg && <p className="pl-text-dim mt-1 break-all">{downloadMsg}</p>}
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleCheckUpdate} disabled={updateState === "checking"}
              className="pl-btn-ghost flex-1 py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 disabled:opacity-40">
              <AlertTriangle size={14} />
              {updateState === "checking" ? "检查中..." : "检测更新"}
            </button>
            <button onClick={handleDownloadUpdate} disabled={downloading || updateState !== "available"}
              className={`flex-1 py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 disabled:opacity-40 ${updateState === "available" ? "pl-btn-primary" : "pl-btn-ghost"}`}>
              <Database size={14} />
              {downloading ? "下载中..." : "立即更新"}
            </button>
          </div>
          <button onClick={() => window.open("https://github.com/0x5477/phantomlink/releases", "_blank")}
            className="pl-btn-ghost w-full mt-2 py-2 rounded-lg text-xs">
            前往 GitHub Releases 页面
          </button>
        </div>
      </Section>

      {/* Self-destruct confirmation modal - IMMEDIATE, no countdown */}
      {showSelfDestruct && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(60, 0, 0, 0.85)" }}>
          <div className="pl-glass-strong rounded-2xl p-8 w-[400px] pl-danger-pulse" style={{ borderColor: "rgba(255, 50, 80, 0.4)" }}>
            {destructing ? (
              <div className="text-center">
                <h3 className="text-lg text-red-400 mb-4 font-bold">数据自毁完成</h3>
                <CheckCircle size={48} className="text-red-400 mx-auto mb-4" />
                <p className="text-xs pl-text-dim">所有加密数据已被不可逆地清除</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <Skull size={28} className="text-red-400" />
                  <h3 className="text-lg text-red-400 font-bold">确认自毁全部数据？</h3>
                </div>
                <p className="text-xs pl-text-dim mb-4">
                  此操作将永久删除所有聊天记录、联系人、加密文件和密钥，无法恢复。确认后将立即执行，无倒计时。
                </p>
                <div className="mb-4">
                  <label className="text-xs pl-text-dim block mb-1.5">
                    请输入 <span className="text-red-400 font-bold">确认自毁</span> 以继续：
                  </label>
                  <input className="pl-input w-full px-3 py-2 text-sm" placeholder="确认自毁" value={destructConfirm}
                    onChange={(e) => setDestructConfirm(e.target.value)}
                    style={{ borderColor: destructConfirm === "确认自毁" ? "rgba(0, 255, 148, 0.4)" : "rgba(255, 50, 80, 0.3)" }} />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setShowSelfDestruct(false); setDestructConfirm(""); }}
                    className="pl-btn-ghost flex-1 py-2.5 rounded-lg text-sm">取消</button>
                  <button onClick={handleSelfDestruct} disabled={destructConfirm !== "确认自毁"}
                    className="flex-1 py-2.5 rounded-lg text-sm bg-red-500/20 border border-red-400/40 text-red-400 disabled:opacity-30 flex items-center justify-center gap-2">
                    <Skull size={14} />立即自毁
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Shield; children: React.ReactNode }) {
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

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/3 last:border-0">
      <div><p className="text-sm">{label}</p><p className="text-xs pl-text-dim">{desc}</p></div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className={`w-11 h-6 rounded-full transition-all relative ${checked ? "bg-cyan-500/30 border border-cyan-400/40" : "bg-white/5 border border-white/10"}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${checked ? "left-5 bg-cyan-400 pl-glow-cyan-sm" : "left-0.5 bg-gray-500"}`} />
    </button>
  );
}
