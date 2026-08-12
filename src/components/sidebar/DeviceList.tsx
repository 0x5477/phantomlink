import { useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import { QrCode, RefreshCw } from "lucide-react";

export default function DeviceList() {
 const devices = useStore((s) => s.devices);
 const loadDevices = useStore((s) => s.loadDevices);
 const setActiveConvId = useStore((s) => s.setActiveConvId);
 const setNavSection = useStore((s) => s.setNavSection);
 const deviceId = useStore((s) => s.deviceId);
 const [showPair, setShowPair] = useState(false);
 const [pairInfo, setPairInfo] = useState<{ code: string; fp: string } | null>(null);

 const handleStartChat = async (peerDeviceId: string) => {
    try {
      const conv = await api.getOrCreatePrivateConversation(peerDeviceId);
      await loadDevices();
      setActiveConvId(conv.conv_id);
      setNavSection("chats");
    } catch (e) {
      console.error(e);
    }
  };

  const handleShowPair = async () => {
    try {
      const info = await api.getDeviceInfo();
      setPairInfo({ code: info.pairing_code, fp: info.fingerprint });
      setShowPair(true);
    } catch (e) {
      console.error(e);
    }
  };

  const otherDevices = devices.filter((d) => d.device_id !== deviceId);

  return (
    <>
      <div className="p-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-medium pl-text-cyan flex-1">联系人</h2>
          <button
            onClick={loadDevices}
            className="pl-btn-ghost rounded-lg p-1.5"
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <button
          onClick={handleShowPair}
          className="pl-btn-primary w-full py-2 rounded-lg text-sm flex items-center justify-center gap-2"
        >
          <QrCode size={14} />
          显示配对码
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {otherDevices.length === 0 ? (
          <div className="p-4 text-center text-xs pl-text-dim">
            暂无已配对设备
            <br />
            请在其他设备上扫描配对码
          </div>
        ) : (
          otherDevices.map((dev) => (
            <button
              key={dev.device_id}
              onClick={() => handleStartChat(dev.device_id)}
              className="w-full text-left px-3 py-3 flex items-center gap-3 hover:bg-white/3 transition-colors border-b border-white/3"
            >
              <div className="w-10 h-10 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-sm pl-text-cyan font-medium">
                {dev.display_name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm truncate">{dev.display_name}</span>
                  {dev.trusted && (
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 pl-glow-green" />
                  )}
                </div>
                <p className="text-xs pl-text-dim font-mono truncate">
                  {dev.fingerprint.substring(0, 23)}...
                </p>
              </div>
            </button>
          ))
        )}
      </div>

      {showPair && pairInfo && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(3, 6, 14, 0.8)" }}
          onClick={() => setShowPair(false)}
        >
          <div
            className="pl-glass-strong pl-glow-cyan rounded-2xl p-8 w-[360px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-center text-sm pl-text-dim mb-4">设备配对码</h3>
            <div className="text-center text-5xl font-bold pl-glow-text-cyan tracking-[0.3em] mb-6 font-mono">
              {pairInfo.code}
            </div>
            <div className="pl-glass rounded-lg p-3 text-center">
              <p className="text-xs pl-text-dim mb-1">设备指纹</p>
              <p className="text-xs font-mono pl-text-cyan break-all">
                {pairInfo.fp}
              </p>
            </div>
            <p className="text-xs pl-text-dim text-center mt-4">
              在其他设备上输入此配对码完成配对
            </p>
            <button
              onClick={() => setShowPair(false)}
              className="pl-btn-ghost w-full py-2 rounded-lg mt-4 text-sm"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
}
