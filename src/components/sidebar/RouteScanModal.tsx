import { useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import type { DiscoveredPeer } from "../../types";
import { Globe, Loader2, UserPlus, X, Route, Network } from "lucide-react";

function suggestNetworks(localIps: string[]): string[] {
  const ip = localIps.find((x) => x.includes(".")) || "";
  const parts = ip.split(".");
  if (parts.length !== 4) return [];
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  const c = parseInt(parts[2], 10);
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return [];
  // Suggest the local /24 plus one /24 on each side (covers typical upstream-router subnets).
  const nets: string[] = [];
  for (let cc = c - 1; cc <= c + 1; cc++) {
    if (cc >= 0 && cc <= 255) nets.push(`${a}.${b}.${cc}.0/24`);
  }
  return nets;
}

export default function RouteScanModal({ onClose }: { onClose: () => void }) {
  const localIps = useStore((s) => s.localIps);
  const [networks, setNetworks] = useState(suggestNetworks(localIps).join(", "));
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<DiscoveredPeer[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const parseNetworks = (): string[] =>
    networks
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s));

  const handleScan = async () => {
    const nets = parseNetworks();
    if (nets.length === 0) { setError("请输入有效的网段，例如 192.168.2.0/24"); return; }
    setScanning(true);
    setError("");
    setResults(null);
    try {
      const found = await api.routeScan(nets);
      setResults(found);
    } catch (e: any) {
      setError(typeof e === "string" ? e : "搜索失败，请检查网段");
    }
    setScanning(false);
  };

  const handleAdd = async (peer: DiscoveredPeer) => {
    setPending((p) => ({ ...p, [peer.device_id]: true }));
    try {
      await api.sendFriendRequest(peer.ip, peer.port, peer.display_name || "Unknown");
      setResults((prev) => (prev || []).filter((x) => x.device_id !== peer.device_id));
    } catch (e: any) {
      alert("发送好友申请失败: " + e);
    }
    setPending((p) => { const n = { ...p }; delete n[peer.device_id]; return n; });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 pl-call-overlay" onClick={onClose}>
      <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-6 w-[440px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4">
          <Route size={18} className="pl-text-cyan" />
          <h3 className="text-sm pl-text-cyan flex-1">路由搜索</h3>
          <button onClick={onClose} className="pl-btn-ghost rounded p-1"><X size={14} /></button>
        </div>

        <p className="text-xs pl-text-dim mb-3">
          跨路由器子网扫描：适用于终端位于上层路由器不同网段（如 192.168.1.x 与 192.168.2.x）的场景。
          输入要搜索的网段（CIDR，可多个，用逗号分隔），将直接探测每个 IP 的 PhantomLink 端口。
        </p>

        <label className="text-xs pl-text-dim block mb-1">目标网段（CIDR）</label>
        <div className="flex gap-2 mb-1">
          <input
            className="pl-input flex-1 px-3 py-2 text-sm font-mono"
            value={networks}
            onChange={(e) => setNetworks(e.target.value)}
            placeholder="192.168.2.0/24, 192.168.3.0/24"
          />
          <button onClick={handleScan} disabled={scanning} className="pl-btn-primary rounded-lg px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50">
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
            {scanning ? "搜索中..." : "开始搜索"}
          </button>
        </div>
        <p className="text-xs pl-text-dim mb-3">
          建议范围：基于本机 IP {localIps.join(", ") || "未检测"} 自动填充相邻网段，也可手动输入。
        </p>

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex-1 overflow-y-auto min-h-[120px]">
          {scanning && <p className="text-xs pl-text-dim text-center py-6">正在跨网段探测...</p>}
          {!scanning && results !== null && results.length === 0 && (
            <p className="text-xs pl-text-dim text-center py-6">未在指定网段发现 PhantomLink 设备</p>
          )}
          {!scanning && results !== null && results.length > 0 && (
            <>
              <p className="text-xs pl-text-dim mb-2">发现 {results.length} 台设备</p>
              {results.map((peer) => (
                <div key={peer.device_id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg pl-glass mb-2">
                  <div className="w-9 h-9 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-xs pl-text-cyan font-medium flex-shrink-0">
                    {peer.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm truncate block">{peer.display_name}</span>
                    <p className="text-xs pl-text-dim font-mono truncate">{peer.ip}:{peer.port} · {peer.fingerprint.substring(0, 10)}...</p>
                  </div>
                  {pending[peer.device_id] ? (
                    <Loader2 size={14} className="animate-spin pl-text-dim" />
                  ) : (
                    <button onClick={() => handleAdd(peer)} className="pl-btn-primary rounded-lg px-3 py-1.5 text-xs flex items-center gap-1.5" title="发送好友申请">
                      <UserPlus size={12} /> 添加
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
          {!scanning && results === null && (
            <div className="text-center py-6 pl-text-dim">
              <Network size={28} className="mx-auto mb-2 opacity-50" />
              <p className="text-xs">输入网段后点击"开始搜索"</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
