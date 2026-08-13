import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";

export default function VoiceCallModal() {
  const voiceCallActive = useStore((s) => s.voiceCallActive);
  const voiceCallRoomId = useStore((s) => s.voiceCallRoomId);
  const voiceCallPeerId = useStore((s) => s.voiceCallPeerId);
  const voiceCallPeerName = useStore((s) => s.voiceCallPeerName);
  const voiceCallIncoming = useStore((s) => s.voiceCallIncoming);
  const setVoiceCall = useStore((s) => s.setVoiceCall);
  const [callState, setCallState] = useState<"ringing" | "connected" | "ended">("ringing");
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sequenceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  // Setup event listeners for voice call signals
  useEffect(() => {
    if (!voiceCallActive) return;

    const setupListeners = async () => {
      unlistenersRef.current.push(
        await listen<{ responder_id: string; room_id: string; accepted: boolean }>("voice-call-response", (event) => {
          if (event.payload.room_id === voiceCallRoomId) {
            if (event.payload.accepted) {
              setCallState("connected");
              startAudioStream();
            } else {
              endCall();
            }
          }
        }),
      );
      unlistenersRef.current.push(
        await listen<{ sender_id: string; room_id: string }>("voice-call-end", (event) => {
          if (event.payload.room_id === voiceCallRoomId) {
            endCall();
          }
        }),
      );
      unlistenersRef.current.push(
        await listen<{ sender_id: string; room_id: string; audio_data: string; sample_rate: number; channels: number }>("voice-data", (event) => {
          if (event.payload.room_id === voiceCallRoomId) {
            playAudioChunk(event.payload.audio_data, event.payload.sample_rate, event.payload.channels);
          }
        }),
      );
    };

    if (!voiceCallIncoming) {
      // Outgoing call - send invite
      if (voiceCallPeerId && voiceCallRoomId) {
        api.sendVoiceCallInvite(voiceCallPeerId, voiceCallRoomId, "private").catch(() => {});
      }
    }

    setupListeners();

    return () => {
      unlistenersRef.current.forEach((u) => u());
      unlistenersRef.current = [];
    };
  }, [voiceCallActive, voiceCallIncoming, voiceCallPeerId, voiceCallRoomId]);

  // Duration timer when connected
  useEffect(() => {
    if (callState === "connected") {
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [callState]);

  const startAudioStream = async () => {
    try {
      audioCtxRef.current = audioCtxRef.current || new AudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (muted) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const samples = Array.from(inputData);
        const b64 = btoa(String.fromCharCode(...new Uint8Array(new Float32Array(samples).buffer)));
        sequenceRef.current += 1;
        if (voiceCallPeerId && voiceCallRoomId) {
          api.sendVoiceFrame(voiceCallPeerId, voiceCallRoomId, sequenceRef.current, b64, audioCtxRef.current!.sampleRate, 1).catch(() => {});
        }
      };

      source.connect(processor);
      processor.connect(audioCtxRef.current.destination);
    } catch (e) {
      console.error("audio stream:", e);
    }
  };

  const playAudioChunk = (b64: string, sampleRate: number, channels: number) => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    try {
      const bytes = atob(b64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const floatData = new Float32Array(buf.buffer);
      const audioBuffer = audioCtxRef.current.createBuffer(channels, floatData.length / channels, sampleRate);
      audioBuffer.copyToChannel(floatData, 0);
      const src = audioCtxRef.current.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioCtxRef.current.destination);
      src.start();
    } catch (e) {
      console.error("play audio:", e);
    }
  };

  const acceptCall = async () => {
    if (voiceCallPeerId && voiceCallRoomId) {
      await api.sendVoiceCallResponse(voiceCallPeerId, voiceCallRoomId, true);
      setCallState("connected");
      startAudioStream();
    }
  };

  const endCall = () => {
    if (voiceCallPeerId && voiceCallRoomId) {
      api.sendVoiceCallEnd(voiceCallPeerId, voiceCallRoomId).catch(() => {});
    }
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (processorRef.current) processorRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (timerRef.current) clearInterval(timerRef.current);
    setCallState("ended");
    setTimeout(() => {
      setVoiceCall({ active: false, roomId: null, peerId: null, peerName: "", incoming: false });
      setCallState("ringing");
      setDuration(0);
    }, 500);
  };

  const toggleMute = () => {
    setMuted(!muted);
  };

  if (!voiceCallActive) return null;

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(3, 6, 14, 0.9)" }}>
      <div className="pl-glass-strong pl-glow-cyan rounded-3xl p-10 w-[400px] flex flex-col items-center">
        <div className="w-20 h-20 rounded-full pl-glass pl-glow-cyan flex items-center justify-center text-2xl pl-text-cyan font-medium mb-4">
          {voiceCallPeerName.charAt(0).toUpperCase()}
        </div>
        <h3 className="text-base font-medium mb-1">{voiceCallPeerName}</h3>
        <p className="text-xs pl-text-dim mb-6">
          {callState === "ringing" && (voiceCallIncoming ? "来电中..." : "正在呼叫...")}
          {callState === "connected" && `通话中 ${formatTime(duration)}`}
          {callState === "ended" && "通话结束"}
        </p>

        {callState === "ringing" && voiceCallIncoming && (
          <div className="flex gap-4">
            <button onClick={acceptCall} className="w-14 h-14 rounded-full bg-green-500/20 border border-green-400/40 text-green-400 flex items-center justify-center hover:scale-110 transition-transform">
              <Phone size={24} />
            </button>
            <button onClick={endCall} className="w-14 h-14 rounded-full bg-red-500/20 border border-red-400/40 text-red-400 flex items-center justify-center hover:scale-110 transition-transform">
              <PhoneOff size={24} />
            </button>
          </div>
        )}

        {callState === "connected" && (
          <div className="flex gap-4">
            <button onClick={toggleMute} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${muted ? "bg-red-500/20 border border-red-400/40 text-red-400" : "pl-glass pl-text-cyan"}`}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>
            <button onClick={endCall} className="w-14 h-14 rounded-full bg-red-500/20 border border-red-400/40 text-red-400 flex items-center justify-center hover:scale-110 transition-transform">
              <PhoneOff size={24} />
            </button>
          </div>
        )}

        {(callState === "ringing" && !voiceCallIncoming) && (
          <button onClick={endCall} className="w-14 h-14 rounded-full bg-red-500/20 border border-red-400/40 text-red-400 flex items-center justify-center hover:scale-110 transition-transform">
            <PhoneOff size={24} />
          </button>
        )}
      </div>
    </div>
  );
}
