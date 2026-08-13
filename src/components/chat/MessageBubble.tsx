import { useEffect, useState, useRef } from "react";
import { Flame, Lock, Check, CheckCheck, Clock, AlertCircle, Play, Pause } from "lucide-react";
import type { ChatMessage } from "../../types";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";

export default function MessageBubble({
  msg,
  isSelf,
  peerName,
}: {
  msg: ChatMessage;
  isSelf: boolean;
  peerName: string;
}) {
  const removeMessage = useStore((s) => s.removeMessage);
  const settings = useStore((s) => s.settings);
  const [burnCountdown, setBurnCountdown] = useState<number | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [voiceData, setVoiceData] = useState<string | null>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (msg.burn_after_read && msg.direction === "received") {
      setBurnCountdown(settings.burn_after_read_delay);
      const interval = setInterval(() => {
        setBurnCountdown((prev) => {
          if (prev === null) return null;
          if (prev <= 1) {
            clearInterval(interval);
            api.burnMessage(msg.message_id).catch(() => {});
            removeMessage(msg.conv_id, msg.message_id);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [msg.burn_after_read, msg.direction, msg.message_id, msg.conv_id]);

  useEffect(() => {
    if (msg.msg_type === "image" && msg.file_info) {
      api.loadFileToBase64(msg.file_info.stored_name).then((b64) => {
        setImageData(`data:${msg.file_info!.mime_type};base64,${b64}`);
      }).catch(() => {});
    }
    if (msg.msg_type === "voice" && msg.file_info) {
      api.loadFileToBase64(msg.file_info.stored_name).then((b64) => {
        setVoiceData(`data:${msg.file_info!.mime_type};base64,${b64}`);
      }).catch(() => {});
    }
  }, [msg.msg_type, msg.file_info]);

  const toggleVoicePlay = () => {
    if (!audioRef.current || !voiceData) return;
    if (voicePlaying) {
      audioRef.current.pause();
      setVoicePlaying(false);
    } else {
      audioRef.current.play();
      setVoicePlaying(true);
    }
  };

  const time = new Date(msg.timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const StatusIcon = () => {
    if (msg.direction !== "sent") return null;
    const cls = "w-3 h-3";
    switch (msg.status) {
      case "pending": return <Clock size={12} className={cls + " pl-text-dim"} />;
      case "sent": return <Check size={14} className={cls + " pl-text-dim"} />;
      case "delivered": return <CheckCheck size={14} className={cls + " pl-text-dim"} />;
      case "read": return <CheckCheck size={14} className={cls + " pl-text-cyan"} />;
      case "failed": return <AlertCircle size={14} className={cls + " text-red-400"} />;
      default: return null;
    }
  };

  // Sticker rendering - large emoji display
  if (msg.msg_type === "sticker") {
    return (
      <div className={`flex ${isSelf ? "justify-end" : "justify-start"} pl-msg-${isSelf ? "sent" : "received"}`}>
        <div className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}>
          {!isSelf && msg.sender_id !== "unknown" && (
            <span className="text-xs pl-text-dim ml-1 mb-0.5">{peerName}</span>
          )}
          <div className="text-6xl p-2 select-none" style={{ animation: "pl-bounce-in 0.4s ease both" }}>
            {msg.content}
          </div>
          <div className={`flex items-center gap-1 ${isSelf ? "justify-end" : ""}`}>
            <span className="text-xs pl-text-dim">{time}</span>
            {isSelf && <StatusIcon />}
          </div>
        </div>
      </div>
    );
  }

  // Voice message rendering
  if (msg.msg_type === "voice") {
    const duration = parseInt(msg.content) || 0;
    return (
      <div className={`flex ${isSelf ? "justify-end" : "justify-start"} pl-msg-${isSelf ? "sent" : "received"}`}>
        <div className={`max-w-[65%] ${isSelf ? "items-end" : "items-start"} flex flex-col`}>
          {!isSelf && msg.sender_id !== "unknown" && (
            <span className="text-xs pl-text-dim ml-1 mb-0.5">{peerName}</span>
          )}
          <div className={`relative rounded-2xl px-4 py-2.5 flex items-center gap-3 ${
            isSelf
              ? "bg-cyan-500/10 border border-cyan-400/20 rounded-br-md"
              : "bg-purple-500/8 border border-purple-400/15 rounded-bl-md"
          }`}>
            <button onClick={toggleVoicePlay} className="w-9 h-9 rounded-full pl-glass flex items-center justify-center pl-text-cyan hover:scale-110 transition-transform">
              {voicePlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="flex items-center gap-0.5">
              {[...Array(Math.min(Math.max(duration, 1), 30))].map((_, i) => (
                <div key={i} className={`w-1 rounded-full ${voicePlaying ? "pl-text-cyan bg-cyan-400/60" : "pl-text-dim bg-white/20"}`}
                  style={{ height: `${8 + Math.sin(i) * 8 + 8}px`, animation: voicePlaying ? `pl-wave 0.5s ease-in-out ${i * 0.05}s infinite alternate` : "none" }} />
              ))}
            </div>
            <span className="text-xs pl-text-dim">{duration}"</span>
            {voiceData && <audio ref={audioRef} src={voiceData} onEnded={() => setVoicePlaying(false)} className="hidden" />}
          </div>
          <div className={`flex items-center gap-1 mt-1 ${isSelf ? "justify-end" : ""}`}>
            {msg.burn_after_read && <Flame size={10} className="text-orange-400/60" />}
            <Lock size={9} className="pl-text-dim opacity-40" />
            <span className="text-xs pl-text-dim">{time}</span>
            {isSelf && <StatusIcon />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isSelf ? "justify-end" : "justify-start"} pl-msg-${isSelf ? "sent" : "received"}`}>
      <div className={`max-w-[65%] ${isSelf ? "items-end" : "items-start"} flex flex-col`}>
        {!isSelf && msg.sender_id !== "unknown" && (
          <span className="text-xs pl-text-dim ml-1 mb-0.5">{peerName}</span>
        )}
        <div className={`relative rounded-2xl px-4 py-2.5 ${
          isSelf
            ? "bg-cyan-500/10 border border-cyan-400/20 rounded-br-md"
            : "bg-purple-500/8 border border-purple-400/15 rounded-bl-md"
        } ${burnCountdown !== null ? "border-orange-400/30" : ""}`}>
          {msg.burn_after_read && burnCountdown !== null && (
            <div className="absolute -top-2 right-2 flex items-center gap-1 bg-orange-500/20 px-1.5 py-0.5 rounded-full">
              <Flame size={10} className="text-orange-400" />
              <span className="text-xs text-orange-400">{burnCountdown}s</span>
            </div>
          )}
          {msg.msg_type === "image" && imageData ? (
            <img src={imageData} alt="img" className="rounded-lg max-w-[280px] max-h-[280px] object-contain cursor-pointer" />
          ) : msg.msg_type === "file" && msg.file_info ? (
            <FileContent msg={msg} />
          ) : (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{msg.content}</p>
          )}
          <div className={`flex items-center gap-1 mt-1 ${isSelf ? "justify-end" : ""}`}>
            {msg.burn_after_read && <Flame size={10} className="text-orange-400/60" />}
            <Lock size={9} className="pl-text-dim opacity-40" />
            <span className="text-xs pl-text-dim">{time}</span>
            {isSelf && <StatusIcon />}
          </div>
        </div>
      </div>
    </div>
  );
}

function FileContent({ msg }: { msg: ChatMessage }) {
  if (!msg.file_info) return <p>{msg.content}</p>;
  const f = msg.file_info;
  const sizeStr = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className="flex items-center gap-3 min-w-[200px]">
      <div className="w-10 h-10 rounded-lg pl-glass flex items-center justify-center flex-shrink-0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.5" className="pl-text-cyan" />
          <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.5" className="pl-text-cyan" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{f.original_name}</p>
        <p className="text-xs pl-text-dim">{sizeStr}</p>
      </div>
    </div>
  );
}
