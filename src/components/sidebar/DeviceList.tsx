import { useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import type { DiscoveredPeer } from "../../types";
import { QrCode, RefreshCw, UserPlus, Trash2, Wifi, Loader2 } from "lucide-react";

export default function DeviceList() {
  const devices = useStore((s) => s.devices);
  const loadDevices = useStore((s) => s.loadDevices);
  const setActiveConvId = useStore((s) => s.setActiveConvId);
  const setNavSection = useStore((s) => s.setNavSection);
  const deviceId = useStore((s) => s.deviceId);
  const [showPair, setShowPair] = useState(false);
  const [pairInfo, setPairInfo] = useState<{ code: string; fp: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [scanning, setScanning] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleStartChat = async (peerDeviceId: string) => {
    try {
      const conv = await api.getOrCreatePrivateConversation(peerDeviceId);
      await loadDevices();
      setActiveConvId(conv.conv_id);
      setNavSection("chats");
    } catch (e) { console.error(e); }
  };

  // Add a discovered peer as a friend, then start chat
  const handleAddPeer = async (peer: DiscoveredPeer) => {
    try {
      await api.addDevice(peer.ip, peer.port, peer.display_name || "Unknown");
      await loadDevices();
      // Remove from discovered list
      setPeers((prev) => prev.filter((p) => p.device_id !== peer.device_id));
    } catch (e) {
      console.error("add peer:", e);
      alert("添加失败: " + e);
    }
  };

  const handleShowPair = async () => {
    try {
      const info = await api.getDeviceInfo();
      setPairInfo({ code: info.pairing_code, fp: info.fingerprint });
      setShowPair(true);
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteDevice(id);
      await loadDevices();
      setDeleteConfirm(null);
    } catch (e) { console.error(e); }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const found = await api.discoverPeers();
      const ownId = deviceId;
      setPeers(found.filter((p) => p.device_id !== ownId));
    } catch (e) { console.error("discover:", e); }
    setScanning(false);
  };

  const otherDevices = devices.filter((d) => d.device_id !== deviceId);

  return (
    <>
      <div className="p-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-medium pl-text-cyan flex-1">联系人</h2>
          <button onClick={handleScan} className="pl-btn-ghost rounded-lg p-1.5" title="扫描局域网">
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
          </button>
          <button onClick={() => setShowAdd(true)} className="pl-btn-ghost rounded-lg p-1.5" title="添加好友">
            <UserPlus size={14} />
          </button>
          <button onClick={loadDevices} className="pl-btn-ghost rounded-lg p-1.5" title="刷新">
            <RefreshCw size={14} />
          </button>
        </div>
        <button onClick={handleShowPair} className="pl-btn-primary w-full py-2 rounded-lg text-sm flex items-center justify-center gap-2">
          <QrCode size={14} />
          显示配对码
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {otherDevices.length === 0 && peers.length === 0 ? (
          <div className="p-4 text-center text-xs pl-text-dim">
            暂无联系人
            <br />
            <span className="opacity-60">点击扫描发现局域网好友</span>
          </div>
        ) : (
          <>
            {peers.length > 0 && (
              <div className="px-3 pt-2 pb-1">
                <p className="text-xs pl-text-dim uppercase tracking-wide">局域网发现</p>
              </div>
            )}
            {peers.map((peer) => (
              <div key={`peer-${peer.device_id}`} className="group w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-white/3 transition-colors border-b border-white/3">
                <div className="w-9 h-9 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-xs pl-text-cyan font-medium flex-shrink-0">
                  {peer.display_name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm truncate block">{peer.display_name}</span>
                  <p className="text-xs pl-text-dim font-mono truncate">{peer.ip}:{peer.port}</p>
                </div>
                <button onClick={() => handleAddPeer(peer)} className="pl-btn-ghost rounded-lg p-1.5" title="添加好友">
                  <UserPlus size={14} className="pl-text-cyan" />
                </button>
              </div>
            ))}

            {otherDevices.length > 0 && peers.length > 0 && (
              <div className="px-3 pt-2 pb-1">
                <p className="text-xs pl-text-dim uppercase tracking-wide">已保存联系人</p>
              </div>
            )}
            {otherDevices.map((dev) => (
              <div key={dev.device_id} className="group w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-white/3 transition-colors border-b border-white/3">
                <button onClick={() => handleStartChat(dev.device_id)} className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-sm pl-text-cyan font-medium">
                    {dev.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm truncate">{dev.display_name}</span>
                      {dev.trusted && <span className="w-1.5 h-1.5 rounded-full bg-green-400 pl-glow-green" />}
                    </div>
                    <p className="text-xs pl-text-dim font-mono truncate">
                      {dev.fingerprint ? dev.fingerprint.substring(0, 23) + "..." : dev.ip || dev.device_id.substring(0, 12)}
                    </p>
                  </div>
                </button>
                <button onClick={() => setDeleteConfirm(dev.device_id)} className="pl-btn-ghost rounded p-1.5 opacity-0 group-hover:opacity-100 transition-opacity" title="删除联系人">
                  <Trash2 size={13} className="text-red-400/70" />
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {showAdd && <AddFriendModal onClose={() => setShowAdd(false)} onAdded={async () => { setShowAdd(false); await loadDevices(); }} />}
      {deleteConfirm && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(3, 6, 14, 0.8)" }} onClick={() => setDeleteConfirm(null)}>
          <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-6 w-[320px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm text-center mb-4">确认删除该联系人？</h3>
            <p className="text-xs pl-text-dim text-center mb-5">将同时删除与此联系人的所有聊天记录</p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="pl-btn-ghost flex-1 py-2 rounded-lg text-sm">取消</button>
              <button onClick={() => handleDelete(deleteConfirm)} className="flex-1 py-2 rounded-lg text-sm bg-red-500/20 border border-red-400/40 text-red-400">删除</button>
            </div>
          </div>
        </div>
      )}
      {showPair && pairInfo && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(3, 6, 14, 0.8)" }} onClick={() => setShowPair(false)}>
          <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-8 w-[360px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-center text-sm pl-text-dim mb-4">设备配对码</h3>
            <div className="text-center text-5xl font-bold pl-glow-text-cyan tracking-[0.3em] mb-6 font-mono">{pairInfo.code}</div>
            <div className="pl-glass rounded-lg p-3 text-center">
              <p className="text-xs pl-text-dim mb-1">设备指纹</p>
              <p className="text-xs font-mono pl-text-cyan break-all">{pairInfo.fp}</p>
            </div>
            <p className="text-xs pl-text-dim text-center mt-4">在其他设备上输入此配对码或扫描局域网完成配对</p>
            <button onClick={() => setShowPair(false)} className="pl-btn-ghost w-full py-2 rounded-lg mt-4 text-sm">关闭</button>
          </div>
        </div>
      )}
    </>
  );
}

function AddFriendModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("48443");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!ip.trim() || !name.trim()) { setError("请填写 IP 地址和备注名称"); return; }
    setLoading(true);
    setError("");
    try {
      await api.addDevice(ip.trim(), parseInt(port) || 48443, name.trim());
      onAdded();
    } catch (e: any) {
      setError(typeof e === "string" ? e : "添加失败，请检查 IP 地址");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(3, 6, 14, 0.8)" }} onClick={onClose}>
      <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-6 w-[380px]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm pl-text-cyan mb-4 flex items-center gap-2"><UserPlus size={16} />添加好友</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs pl-text-dim block mb-1">IP 地址</label>
            <input className="pl-input w-full px-3 py-2 text-sm" placeholder="192.168.1.100" value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
          </div>
          <div>
            <label className="text-xs pl-text-dim block mb-1">端口</label>
            <input className="pl-input w-full px-3 py-2 text-sm" placeholder="48443" value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
          </div>
          <div>
            <label className="text-xs pl-text-dim block mb-1">备注名称</label>
            <input className="pl-input w-full px-3 py-2 text-sm" placeholder="好友昵称" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
          </div>
        </div>
        {error && <p className="text-xs text-red-400 mt-3 text-center">{error}</p>}
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="pl-btn-ghost flex-1 py-2 rounded-lg text-sm">取消</button>
          <button onClick={handleSubmit} disabled={loading} className="pl-btn-primary flex-1 py-2 rounded-lg text-sm flex items-center justify-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? "连接中..." : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
