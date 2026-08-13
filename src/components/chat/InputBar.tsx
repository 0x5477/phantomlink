import { useState, useRef, useEffect } from "react";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { Send, Paperclip, Smile, Flame, X, Camera, Mic, Sticker } from "lucide-react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import { startVoiceRecorder, type VoiceRecorder } from "../../lib/audio";

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const STICKERS = [
  "🎉", "🎊", "🎈", "🎁", "🏆", "💯", "🔥", "⭐",
  "😍", "🥰", "😎", "🤣", "😭", "😡", "🤔", "😴",
  "👍", "👎", "👏", "🙌", "🤝", "✌️", "🤞", "🤙",
  "❤️", "💜", "💙", "💚", "💛", "🧡", "🖤", "💔",
  "🌈", "⚡", "💫", "🌟", "💎", "🎯", "🎮", "🎧",
  "🐱", "🐶", "🦊", "🐼", "🤖", "👻", "🎃", "👑",
];

export default function InputBar({ convId }: { convId: string }) {
  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [burnMode, setBurnMode] = useState(false);
  const [filePreview, setFilePreview] = useState<{ name: string; size: number; b64: string; mime: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const appendMessage = useStore((s) => s.appendMessage);
  const updateMessageInStore = useStore((s) => s.updateMessageInStore);
  const conversations = useStore((s) => s.conversations);
  const settings = useStore((s) => s.settings);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef(0);

  const conv = conversations.find((c) => c.conv_id === convId);
  const peerDeviceId = conv?.peer_device_id ?? null;
  const isDark = settings.theme !== "light";

  // Screenshot shortcut: Alt+A to avoid conflicts with system screenshot tools
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "a" || e.key === "A") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        await handleScreenshot();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [convId, peerDeviceId]);

  const handleScreenshot = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read().catch(() => null);
      if (clipboardItems) {
        for (const type of (clipboardItems as any).types || []) {
          if (type.startsWith("image/")) {
            const blob = await (clipboardItems as any).getType(type);
            const reader = new FileReader();
            reader.onload = async () => {
              const result = reader.result as string;
              const b64 = result.split(",")[1];
              setFilePreview({ name: `screenshot_${Date.now()}.png`, size: blob.size, b64, mime: "image/png" });
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
      alert("请先截图（Win: Win+Shift+S, Mac: Cmd+Shift+4），截图后自动粘贴到输入框。快捷键 Alt+A");
    } catch (e) {
      console.error("screenshot:", e);
    }
  };

  const handleSend = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const msg = await api.saveLocalMessage(convId, "text", text.trim(), "sent", burnMode);
      appendMessage(convId, msg);
      setText("");
      if (peerDeviceId) {
        try {
          await api.sendMessageFrame(peerDeviceId, msg.message_id, "text", text.trim(), burnMode);
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) {
          console.error("network send failed:", e);
          updateMessageInStore(convId, msg.message_id, { status: "failed" });
        }
      }
    } catch (e) { console.error(e); }
    setSending(false);
  };

  const handleStickerSend = async (sticker: string) => {
    setShowStickers(false);
    try {
      const msg = await api.saveLocalMessage(convId, "sticker", sticker, "sent", false);
      appendMessage(convId, msg);
      if (peerDeviceId) {
        try {
          await api.sendStickerFrame(peerDeviceId, msg.message_id, sticker);
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) { console.error("sticker send failed:", e); }
      }
    } catch (e) { console.error(e); }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { alert(`文件过大（限制${MAX_FILE_SIZE / 1024 / 1024}MB）`); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result as string;
      const b64 = result.split(",")[1];
      setFilePreview({ name: file.name, size: file.size, b64, mime: file.type });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handleSendFile = async () => {
    if (!filePreview || sending) return;
    setSending(true);
    try {
      const isImage = filePreview.mime?.startsWith("image/") ?? false;
      const msgType = isImage ? "image" : "file";
      const fileRec = await api.saveFileFromBase64(filePreview.name, filePreview.mime || "application/octet-stream", filePreview.b64);
      const msg = await api.saveLocalMessage(convId, msgType, filePreview.name, "sent", burnMode, fileRec.file_id);
      appendMessage(convId, msg);
      const fname = filePreview.name;
      setFilePreview(null);
      if (peerDeviceId) {
        try {
          await api.sendMessageFrame(peerDeviceId, msg.message_id, msgType, fname, burnMode);
          await api.sendFileFrame(peerDeviceId, msg.message_id, fileRec.file_id);
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) {
          console.error("file send failed:", e);
          updateMessageInStore(convId, msg.message_id, { status: "failed" });
        }
      }
    } catch (e) { console.error(e); alert("发送文件失败"); }
    setSending(false);
  };

  // Voice message recording (WAV via ScriptProcessor; plays everywhere incl. WKWebView)
  const startRecording = async () => {
    try {
      const recorder = await startVoiceRecorder({
        onTick: (secs) => setRecordTime(secs),
      });
      recorderRef.current = recorder;
      recordStartRef.current = Date.now();
      setRecording(true);
      setRecordTime(0);
    } catch (e) {
      console.error("mic access:", e);
      alert("无法访问麦克风，请检查权限");
    }
  };

  const stopRecording = async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setRecording(false);
    if (!recorder) return;
    try {
      const { b64, durationSecs } = await recorder.stop();
      const duration = Math.max(1, Math.round(durationSecs));
      const fileName = `voice_${Date.now()}.wav`;
      const fileRec = await api.saveFileFromBase64(fileName, "audio/wav", b64);
      const msg = await api.saveLocalMessage(convId, "voice", `${duration}`, "sent", false, fileRec.file_id);
      appendMessage(convId, msg);
      if (peerDeviceId) {
        try {
          await api.sendVoiceMessageFrame(peerDeviceId, msg.message_id, duration, "audio/wav", b64);
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) {
          console.error("voice send failed:", e);
          updateMessageInStore(convId, msg.message_id, { status: "failed" });
        }
      }
    } catch (e) {
      console.error(e);
      alert("语音发送失败");
    }
  };

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      recorderRef.current?.cancel();
      recorderRef.current = null;
    };
  }, []);

  return (
    <div className="pl-glass border-t border-white/5 px-4 py-3 relative">
      {showEmoji && (
        <div className="absolute bottom-full right-4 mb-2 z-50">
          <EmojiPicker onEmojiClick={(emoji) => { setText((prev) => prev + emoji.emoji); setShowEmoji(false); }}
            theme={isDark ? Theme.DARK : Theme.LIGHT} emojiStyle={EmojiStyle.NATIVE} width={320} height={360} previewConfig={{ showPreview: false }} />
        </div>
      )}
      {showStickers && (
        <div className="absolute bottom-full left-4 mb-2 z-50 pl-glass-strong rounded-xl p-3" style={{ width: 340 }}>
          <p className="text-xs pl-text-dim mb-2">表情包</p>
          <div className="grid grid-cols-8 gap-1 max-h-[240px] overflow-y-auto">
            {STICKERS.map((s, i) => (
              <button key={i} onClick={() => handleStickerSend(s)} className="w-9 h-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-xl transition-all hover:scale-110">
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {filePreview && (
        <div className="pl-glass rounded-lg p-3 mb-2 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg pl-glass flex items-center justify-center"><Paperclip size={16} className="pl-text-cyan" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">{filePreview.name}</p>
            <p className="text-xs pl-text-dim">{(filePreview.size / 1024).toFixed(1)} KB</p>
          </div>
          <button onClick={() => setFilePreview(null)} className="pl-btn-ghost rounded p-1.5"><X size={14} /></button>
          <button onClick={handleSendFile} disabled={sending} className="pl-btn-primary rounded-lg px-3 py-1.5 text-sm">发送</button>
        </div>
      )}
      {recording && (
        <div className="pl-glass rounded-lg p-3 mb-2 flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm text-red-400 flex-1">录制中... {Math.floor(recordTime / 60)}:{String(recordTime % 60).padStart(2, "0")}</span>
          <button onClick={stopRecording} className="pl-btn-primary rounded-lg px-3 py-1.5 text-sm">发送语音</button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <button onClick={() => fileInputRef.current?.click()} className="pl-btn-ghost rounded-lg p-2 flex-shrink-0" title="发送文件">
          <Paperclip size={18} />
        </button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect}
          accept="image/jpeg,image/png,image/gif,.docx,.xlsx,.pdf,.zip,.7z,.txt,.doc,.xls,.pptx" />

        <button onClick={handleScreenshot} className="pl-btn-ghost rounded-lg p-2 flex-shrink-0" title="截图 (Alt+A)">
          <Camera size={18} />
        </button>

        <button onClick={() => setShowStickers(!showStickers)}
          className={`rounded-lg p-2 flex-shrink-0 transition-all ${showStickers ? "pl-btn-primary" : "pl-btn-ghost"}`} title="表情包">
          <Sticker size={18} />
        </button>

        <button onClick={() => setShowEmoji(!showEmoji)}
          className={`rounded-lg p-2 flex-shrink-0 transition-all ${showEmoji ? "pl-btn-primary" : "pl-btn-ghost"}`} title="表情">
          <Smile size={18} />
        </button>

        <button onClick={() => setBurnMode(!burnMode)}
          className={`rounded-lg p-2 flex-shrink-0 transition-all ${burnMode ? "bg-orange-500/15 border border-orange-400/40 text-orange-400 pl-glow-green" : "pl-btn-ghost"}`} title="阅后即焚">
          <Flame size={18} />
        </button>

        {recording ? (
          <button onClick={stopRecording} className="pl-btn-primary rounded-lg p-2.5 flex-shrink-0 animate-pulse" title="停止录制">
            <Mic size={18} />
          </button>
        ) : (
          <button onClick={startRecording} className="pl-btn-ghost rounded-lg p-2.5 flex-shrink-0" title="语音消息">
            <Mic size={18} />
          </button>
        )}

        <textarea className="pl-input flex-1 px-4 py-2.5 text-sm resize-none max-h-24"
          placeholder={burnMode ? "阅后即焚消息..." : "输入消息..."} value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          rows={1} />

        <button onClick={handleSend} disabled={!text.trim() || sending}
          className="pl-btn-primary rounded-lg p-2.5 flex-shrink-0 disabled:opacity-30" title="发送 (Enter)">
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
