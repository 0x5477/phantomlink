import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Phone, PhoneOff, Mic, MicOff, Users } from "lucide-react";
import type { VoiceCallParticipant } from "../../types";

const BUFFER_SIZE = 2048;

export default function VoiceCallModal() {
  const voiceCallActive = useStore((s) => s.voiceCallActive);
  const voiceCallRoomId = useStore((s) => s.voiceCallRoomId);
  const voiceCallPeerId = useStore((s) => s.voiceCallPeerId);
  const voiceCallPeerName = useStore((s) => s.voiceCallPeerName);
  const voiceCallIncoming = useStore((s) => s.voiceCallIncoming);
  const voiceCallHostId = useStore((s) => s.voiceCallHostId);
  const voiceCallParticipants = useStore((s) => s.voiceCallParticipants);
  const voiceCallTargets = useStore((s) => s.voiceCallTargets);
  const deviceId = useStore((s) => s.deviceId);
  const deviceName = useStore((s) => s.deviceName);
  const setVoiceCall = useStore((s) => s.setVoiceCall);
  const [callState, setCallState] = useState<"ringing" | "connected" | "ended">("ringing");
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sequenceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const joinedRef = useRef(false);
  const mutedRef = useRef(false);
  const localNameRef = useRef(deviceName || "我");

  useEffect(() => { localNameRef.current = deviceName || "我"; }, [deviceName]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const isHost = !!voiceCallHostId && voiceCallHostId === deviceId;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const roomIdRef = useRef(voiceCallRoomId);
  roomIdRef.current = voiceCallRoomId;
  const hostIdRef = useRef(voiceCallHostId);
  hostIdRef.current = voiceCallHostId;

  const resetAll = () => {
    setCallState("ringing");
    setDuration(0);
    setMuted(false);
    mutedRef.current = false;
    joinedRef.current = false;
    setVoiceCall({ active: false, roomId: null, peerId: null, peerName: "", incoming: false, hostId: null, participants: [], targets: [] });
  };

  const cleanupAudio = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { processorRef.current?.disconnect(); } catch {}
    try { sourceRef.current?.disconnect(); } catch {}
    try { gainRef.current?.disconnect(); } catch {}
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    try { if (audioCtxRef.current && audioCtxRef.current.state !== "closed") void audioCtxRef.current.close(); } catch {}
    audioCtxRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    gainRef.current = null;
    sequenceRef.current = 0;
  };

  const endCall = () => {
    // Notify the room (host ends for everyone, participant leaves).
    const roomId = roomIdRef.current;
    const hostId = hostIdRef.current;
    if (roomId) {
      if (isHostRef.current) {
        api.voiceCallEndRoom(roomId).catch(() => {});
      } else if (hostId) {
        api.voiceCallLeave(hostId, roomId).catch(() => {});
      }
    }
    cleanupAudio();
    setCallState("ended");
    setTimeout(resetAll, 600);
  };

  // Capture mic + send loop (host sends to all participants, participant sends to host).
  const startAudioStream = async () => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      if (audioCtxRef.current.state === "suspended") await audioCtxRef.current.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = audioCtxRef.current;
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      // Zero-gain output: keeps the graph alive without echoing the mic to speakers.
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      processor.onaudioprocess = (e) => {
        const st = useStore.getState();
        if (!st.voiceCallActive || st.voiceCallRoomId !== roomIdRef.current) return;
        if (mutedRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const samples = new Float32Array(inputData);
        const bytes = new Uint8Array(samples.buffer);
        let b64 = "";
        for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        b64 = btoa(b64);
        sequenceRef.current += 1;
        const roomId = roomIdRef.current!;
        const seq = sequenceRef.current;
        const sampleRate = ctx.sampleRate;
        if (isHostRef.current) {
          // Host: send directly to every other participant.
          const others = st.voiceCallParticipants.filter((p) => p.device_id !== st.deviceId);
          for (const p of others) {
            api.sendVoiceFrame(p.device_id, roomId, seq, b64, sampleRate, 1).catch(() => {});
          }
        } else if (hostIdRef.current) {
          // Participant: send to the host, which relays to the rest.
          api.sendVoiceFrame(hostIdRef.current, roomId, seq, b64, sampleRate, 1).catch(() => {});
        }
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(ctx.destination);
    } catch (e) {
      console.error("audio stream:", e);
      alert("无法访问麦克风，请检查权限");
    }
  };

  const playAudioChunk = (b64: string, sampleRate: number, channels: number) => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") void ctx.resume();
    try {
      const bytes = atob(b64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const floatData = new Float32Array(buf.buffer);
      const audioBuffer = ctx.createBuffer(channels, floatData.length / channels, sampleRate);
      audioBuffer.copyToChannel(floatData, 0);
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      src.start();
    } catch (e) {
      console.error("play audio:", e);
    }
  };

  // Set up listeners + initial actions when the call becomes active.
  useEffect(() => {
    if (!voiceCallActive) return;

    const setup = async () => {
      unlistenersRef.current.push(
        await listen<{ room_id: string; participants: string[]; names: string[] }>("voice-call-participants", (event) => {
          if (event.payload.room_id !== voiceCallRoomId) return;
          const participants: VoiceCallParticipant[] = event.payload.participants.map((device_id, i) => ({
            device_id,
            name: event.payload.names[i] || device_id.slice(0, 8),
          }));
          useStore.getState().setVoiceCall({ participants });
          // Participant becomes connected once the host has registered us.
          if (!isHostRef.current && !joinedRef.current && voiceCallRoomId) {
            const me = useStore.getState().deviceId;
            if (participants.some((p) => p.device_id === me)) {
              joinedRef.current = true;
              setCallState("connected");
              void startAudioStream();
            }
          } else if (isHostRef.current && participants.length >= 2) {
            // Host: a participant joined -> call is live.
            setCallState("connected");
          }
        }),
      );
      unlistenersRef.current.push(
        await listen<{ sender_id: string; room_id: string }>("voice-call-end", (event) => {
          if (event.payload.room_id === voiceCallRoomId) endCall();
        }),
      );
      unlistenersRef.current.push(
        await listen<{ responder_id: string; room_id: string; accepted: boolean }>("voice-call-response", (event) => {
          if (event.payload.room_id === voiceCallRoomId && !event.payload.accepted) {
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

      if (isHost) {
        // Host: create the room and invite everyone.
        if (voiceCallRoomId) {
          await api.voiceCallStartRoom(voiceCallRoomId).catch((e) => console.error("start room:", e));
          const targets = voiceCallTargets.length > 0 ? voiceCallTargets : (voiceCallPeerId ? [{ device_id: voiceCallPeerId, name: voiceCallPeerName }] : []);
          for (const t of targets) {
            await api.sendVoiceCallInvite(t.device_id, voiceCallRoomId, targets.length > 1 ? "group" : "private").catch(() => {});
          }
          // Host's own mic starts right away; audio is sent to participants as they join.
          const me = useStore.getState().deviceId;
          useStore.getState().setVoiceCall({ participants: [{ device_id: me || "", name: localNameRef.current }] });
          void startAudioStream();
        }
      }
    };

    void setup();

    return () => {
      unlistenersRef.current.forEach((u) => u());
      unlistenersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceCallActive]);

  // Duration timer
  useEffect(() => {
    if (callState === "connected") {
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [callState]);

  const acceptCall = async () => {
    if (!voiceCallPeerId || !voiceCallRoomId) return;
    await api.voiceCallJoin(voiceCallPeerId, voiceCallRoomId).catch((e) => console.error("join:", e));
    setCallState("connected");
    joinedRef.current = true;
    void startAudioStream();
  };

  const rejectCall = async () => {
    if (voiceCallPeerId && voiceCallRoomId) {
      await api.sendVoiceCallResponse(voiceCallPeerId, voiceCallRoomId, false).catch(() => {});
    }
    cleanupAudio();
    resetAll();
  };

  const toggleMute = () => setMuted((m) => !m);

  if (!voiceCallActive) return null;

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const displayParticipants = voiceCallParticipants.length > 0 ? voiceCallParticipants : (voiceCallTargets.length > 0 ? voiceCallTargets : (voiceCallPeerId ? [{ device_id: voiceCallPeerId, name: voiceCallPeerName }] : []));
  const others = displayParticipants.filter((p) => p.device_id !== deviceId);
  const title = isHost
    ? (others.length > 1 ? `群通话 (${others.length + 1}人)` : (others[0]?.name || "通话"))
    : (voiceCallPeerName || "通话");

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 pl-call-overlay">
      <div className="pl-glass-strong pl-glow-cyan rounded-3xl p-8 w-[400px] flex flex-col items-center">
        <div className="w-20 h-20 rounded-full pl-glass pl-glow-cyan flex items-center justify-center text-2xl pl-text-cyan font-medium mb-4">
          {title.charAt(0).toUpperCase()}
        </div>
        <h3 className="text-base font-medium mb-1">{title}</h3>
        <p className="text-xs pl-text-dim mb-4">
          {callState === "ringing" && (voiceCallIncoming ? "来电中..." : "正在呼叫...")}
          {callState === "connected" && `通话中 ${formatTime(duration)}`}
          {callState === "ended" && "通话结束"}
        </p>

        {/* Participant list */}
        {callState === "connected" && displayParticipants.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 mb-5 max-w-full">
            {displayParticipants.map((p) => (
              <span key={p.device_id} className={`text-xs px-2.5 py-1 rounded-full flex items-center gap-1 ${p.device_id === deviceId ? "pl-btn-primary" : "pl-glass"}`}>
                <Users size={11} />
                {p.name}{p.device_id === deviceId ? "（我）" : ""}
              </span>
            ))}
          </div>
        )}

        {callState === "ringing" && voiceCallIncoming && (
          <div className="flex gap-4">
            <button onClick={acceptCall} className="w-14 h-14 rounded-full bg-green-500/20 border border-green-400/40 text-green-400 flex items-center justify-center hover:scale-110 transition-transform">
              <Phone size={24} />
            </button>
            <button onClick={rejectCall} className="w-14 h-14 rounded-full bg-red-500/20 border border-red-400/40 text-red-400 flex items-center justify-center hover:scale-110 transition-transform">
              <PhoneOff size={24} />
            </button>
          </div>
        )}

        {callState === "connected" && (
          <div className="flex gap-4">
            <button onClick={toggleMute} className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${muted ? "bg-red-500/20 border border-red-400/40 text-red-400" : "pl-glass pl-text-cyan"}`} title={muted ? "取消静音" : "静音"}>
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
