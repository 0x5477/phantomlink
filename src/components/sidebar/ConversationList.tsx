import { Plus, Search } from "lucide-react";
import { useState, useEffect } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import type { ChatMessage } from "../../types";

export default function ConversationList() {
  const conversations = useStore((s) => s.conversations);
  const activeConvId = useStore((s) => s.activeConvId);
  const setActiveConvId = useStore((s) => s.setActiveConvId);
  const setNavSection = useStore((s) => s.setNavSection);
  const messages = useStore((s) => s.messages);
  const devices = useStore((s) => s.devices);
  const deviceId = useStore((s) => s.deviceId);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
  const [showNewConv, setShowNewConv] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return; }
    const timer = setTimeout(async () => {
      try {
        const results = await api.searchMessages(query.trim());
        setSearchResults(results);
      } catch { setSearchResults(null); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const filtered = conversations.filter((c) =>
    c.display_name.toLowerCase().includes(query.toLowerCase()),
  );

  const handleClick = (convId: string) => {
    setActiveConvId(convId);
    api.resetUnread(convId);
  };

  const startNewConversation = async (peerDeviceId: string) => {
    try {
      const conv = await api.getOrCreatePrivateConversation(peerDeviceId);
      await useStore.getState().loadConversations();
      setActiveConvId(conv.conv_id);
      setShowNewConv(false);
      setNavSection("chats");
    } catch (e) { console.error(e); }
  };

  const otherDevices = devices.filter((d) => d.device_id !== deviceId);

  return (
    <>
      <div className="p-3 border-b border-white/5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-medium pl-text-cyan flex-1">会话</h2>
          <button onClick={() => setShowNewConv(true)} className="pl-btn-ghost rounded-lg p-1.5" title="新建会话">
            <Plus size={16} />
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pl-text-dim" />
          <input
            className="pl-input w-full pl-8 pr-3 py-2 text-sm"
            placeholder="搜索会话或聊天记录..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {searchResults && searchResults.length > 0 && (
          <div className="px-3 pt-2 pb-1">
            <p className="text-xs pl-text-dim uppercase tracking-wide">聊天记录匹配</p>
          </div>
        )}
        {searchResults?.map((msg) => {
          const conv = conversations.find((c) => c.conv_id === msg.conv_id);
          return (
            <button
              key={`search-${msg.message_id}`}
              onClick={() => handleClick(msg.conv_id)}
              className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-white/3 transition-colors border-b border-white/3"
            >
              <div className="w-8 h-8 rounded-full pl-glass flex items-center justify-center text-xs pl-text-cyan flex-shrink-0">
                {conv?.display_name?.charAt(0).toUpperCase() || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs pl-text-cyan">{conv?.display_name || "Unknown"}</span>
                <p className="text-xs truncate pl-text-dim">{msg.content}</p>
              </div>
            </button>
          );
        })}
        {searchResults && searchResults.length === 0 && query.trim() && (
          <div className="p-3 text-center text-xs pl-text-dim">未找到匹配的聊天记录</div>
        )}

        {searchResults === null && (
          <>
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-xs pl-text-dim">
                {query ? "无匹配结果" : "暂无会话，点击右上角+发起聊天"}
              </div>
            ) : (
              filtered.map((conv) => {
                const lastMsgs = messages[conv.conv_id] || [];
                const lastMsg = lastMsgs[lastMsgs.length - 1];
                const isActive = conv.conv_id === activeConvId;
                return (
                  <button
                    key={conv.conv_id}
                    onClick={() => handleClick(conv.conv_id)}
                    className={`w-full text-left px-3 py-3 flex items-center gap-3 transition-colors border-l-2 ${
                      isActive ? "bg-cyan-500/5 border-cyan-400" : "border-transparent hover:bg-white/3"
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                      conv.conv_type === "group" ? "pl-glass-purple pl-text-purple" : "pl-glass pl-glow-cyan-sm pl-text-cyan"
                    }`}>
                      {conv.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm truncate">{conv.display_name}</span>
                        {conv.unread_count > 0 && (
                          <span className="text-xs bg-cyan-500/20 pl-text-cyan px-1.5 rounded-full min-w-[18px] text-center">{conv.unread_count}</span>
                        )}
                      </div>
                      <p className="text-xs pl-text-dim truncate">
                        {lastMsg ? (lastMsg.msg_type === "file" ? `[文件] ${lastMsg.content}` : lastMsg.msg_type === "image" ? "[图片]" : lastMsg.msg_type === "voice" ? "[语音]" : lastMsg.msg_type === "sticker" ? "[表情包]" : lastMsg.content) : "暂无消息"}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </>
        )}
      </div>

      {showNewConv && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(3, 6, 14, 0.8)" }} onClick={() => setShowNewConv(false)}>
          <div className="pl-glass-strong pl-glow-cyan rounded-2xl p-6 w-[360px] max-h-[400px] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm pl-text-cyan mb-4 flex items-center gap-2"><Plus size={16} />新建会话</h3>
            <div className="flex-1 overflow-y-auto space-y-1">
              {otherDevices.length === 0 ? (
                <p className="text-xs pl-text-dim text-center py-4">暂无联系人，请先在联系人页面添加好友</p>
              ) : (
                otherDevices.map((dev) => (
                  <button key={dev.device_id} onClick={() => startNewConversation(dev.device_id)}
                    className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-white/5 rounded-lg transition-colors">
                    <div className="w-9 h-9 rounded-full pl-glass pl-glow-cyan-sm flex items-center justify-center text-xs pl-text-cyan font-medium">
                      {dev.display_name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm">{dev.display_name}</span>
                  </button>
                ))
              )}
            </div>
            <button onClick={() => setShowNewConv(false)} className="pl-btn-ghost w-full py-2 rounded-lg mt-3 text-sm">取消</button>
          </div>
        </div>
      )}
    </>
  );
}
