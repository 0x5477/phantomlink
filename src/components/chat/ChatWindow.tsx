import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import MessageBubble from "./MessageBubble";
import InputBar from "./InputBar";
import { Shield, Lock } from "lucide-react";

export default function ChatWindow({ convId }: { convId: string }) {
  const messages = useStore((s) => s.messages[convId] || []);
  const conversations = useStore((s) => s.conversations);
  const devices = useStore((s) => s.devices);
  const deviceId = useStore((s) => s.deviceId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const conv = conversations.find((c) => c.conv_id === convId);
  const peer = conv?.peer_device_id
    ? devices.find((d) => d.device_id === conv.peer_device_id)
    : null;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="pl-glass border-b border-white/5 px-5 py-3 flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium ${
            conv?.conv_type === "group"
              ? "pl-glass-purple pl-text-purple"
              : "pl-glass pl-glow-cyan-sm pl-text-cyan"
          }`}
        >
          {conv?.display_name?.charAt(0).toUpperCase() || "?"}
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-medium">
            {conv?.display_name || "Unknown"}
          </h2>
          <div className="flex items-center gap-1.5 text-xs pl-text-dim">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 pl-glow-green" />
            {conv?.conv_type === "group" ? "群组 · 已加密" : "端到端加密"}
          </div>
        </div>
        <Shield size={16} className="pl-text-cyan opacity-60" />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-2"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center pl-text-dim">
            <Lock size={32} className="mb-3 opacity-40" />
            <p className="text-sm">开始加密对话</p>
            <p className="text-xs mt-1 opacity-60">
              所有消息均经过 AES-256-GCM 端到端加密
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.message_id}
              msg={msg}
              isSelf={msg.direction === "sent" || msg.sender_id === deviceId}
              peerName={peer?.display_name || conv?.display_name || "Unknown"}
            />
          ))
        )}
      </div>

      {/* Input */}
      <InputBar convId={convId} />
    </div>
  );
}
