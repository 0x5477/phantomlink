import { useState, useRef } from "react";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { Send, Paperclip, Smile, Flame, X } from "lucide-react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";

export default function InputBar({ convId }: { convId: string }) {
  const [text, setText] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [burnMode, setBurnMode] = useState(false);
  const [filePreview, setFilePreview] = useState<{
    name: string;
    size: number;
    b64: string;
    mime: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const appendMessage = useStore((s) => s.appendMessage);
  const updateMessageInStore = useStore((s) => s.updateMessageInStore);
  const conversations = useStore((s) => s.conversations);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const conv = conversations.find((c) => c.conv_id === convId);
  const peerDeviceId = conv?.peer_device_id ?? null;

  const handleSend = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      const msg = await api.saveLocalMessage(
        convId,
        "text",
        text.trim(),
        "sent",
        burnMode,
      );
      appendMessage(convId, msg);
      setText("");

      // Send over network
      if (peerDeviceId) {
        try {
          await api.sendMessageFrame(
            peerDeviceId,
            msg.message_id,
            "text",
            text.trim(),
            burnMode,
          );
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) {
          console.error("network send failed:", e);
          updateMessageInStore(convId, msg.message_id, { status: "failed" });
        }
      }
    } catch (e) {
      console.error(e);
    }
    setSending(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      alert("文件过大（限制50MB）");
      return;
    }
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

      // 1. Save file to encrypted store
      const fileRec = await api.saveFileFromBase64(
        filePreview.name,
        filePreview.mime || "application/octet-stream",
        filePreview.b64,
      );

      // 2. Save message locally with file_id linked
      const msg = await api.saveLocalMessage(
        convId,
        msgType,
        filePreview.name,
        "sent",
        burnMode,
        fileRec.file_id,
      );
      appendMessage(convId, msg);
      setFilePreview(null);

      // 3. Send message frame + file chunks over network
      if (peerDeviceId) {
        try {
          await api.sendMessageFrame(
            peerDeviceId,
            msg.message_id,
            msgType,
            filePreview.name,
            burnMode,
          );
          await api.sendFileFrame(peerDeviceId, msg.message_id, fileRec.file_id);
          updateMessageInStore(convId, msg.message_id, { status: "sent" });
        } catch (e) {
          console.error("file send failed:", e);
          updateMessageInStore(convId, msg.message_id, { status: "failed" });
        }
      }
    } catch (e) {
      console.error(e);
      alert("发送文件失败");
    }
    setSending(false);
  };

  return (
    <div className="pl-glass border-t border-white/5 px-4 py-3 relative">
      {showEmoji && (
        <div className="absolute bottom-full right-4 mb-2 z-50">
          <EmojiPicker
            onEmojiClick={(emoji) => {
              setText((prev) => prev + emoji.emoji);
              setShowEmoji(false);
            }}
            theme={Theme.DARK}
            emojiStyle={EmojiStyle.NATIVE}
            width={320}
            height={360}
            previewConfig={{ showPreview: false }}
          />
        </div>
      )}

      {filePreview && (
        <div className="pl-glass rounded-lg p-3 mb-2 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg pl-glass flex items-center justify-center">
            <Paperclip size={16} className="pl-text-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">{filePreview.name}</p>
            <p className="text-xs pl-text-dim">
              {(filePreview.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <button
            onClick={() => setFilePreview(null)}
            className="pl-btn-ghost rounded p-1.5"
          >
            <X size={14} />
          </button>
          <button
            onClick={handleSendFile}
            disabled={sending}
            className="pl-btn-primary rounded-lg px-3 py-1.5 text-sm"
          >
            发送
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="pl-btn-ghost rounded-lg p-2 flex-shrink-0"
          title="发送文件"
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileSelect}
          accept="image/jpeg,image/png,image/gif,.docx,.xlsx,.pdf,.zip,.7z,.txt,.doc,.xls,.pptx"
        />

        <button
          onClick={() => setShowEmoji(!showEmoji)}
          className={`rounded-lg p-2 flex-shrink-0 transition-all ${
            showEmoji ? "pl-btn-primary" : "pl-btn-ghost"
          }`}
          title="表情"
        >
          <Smile size={18} />
        </button>

        <button
          onClick={() => setBurnMode(!burnMode)}
          className={`rounded-lg p-2 flex-shrink-0 transition-all ${
            burnMode
              ? "bg-orange-500/15 border border-orange-400/40 text-orange-400 pl-glow-green"
              : "pl-btn-ghost"
          }`}
          title="阅后即焚"
        >
          <Flame size={18} />
        </button>

        <textarea
          className="pl-input flex-1 px-4 py-2.5 text-sm resize-none max-h-24"
          placeholder={burnMode ? "阅后即焚消息..." : "输入消息..."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
        />

        <button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="pl-btn-primary rounded-lg p-2.5 flex-shrink-0 disabled:opacity-30"
          title="发送 (Enter)"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
