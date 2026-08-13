// Audio utilities: WAV encode/decode + mic recording.
// Using WAV (16-bit PCM) guarantees playback on every WebView (incl. WKWebView
// which does not play webm/opus), and gives us raw PCM for real-time calls.

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

function concatFloat32(arrays: Float32Array[]): Float32Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Encode 32-bit float PCM samples into a 16-bit PCM WAV ArrayBuffer. */
export function encodeWav(samples: Float32Array, sampleRate: number, channels: number): ArrayBuffer {
  const numFrames = samples.length / channels;
  const bytesPerSample = 2;
  const dataSize = numFrames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Decode a 16-bit PCM WAV ArrayBuffer into float samples. */
export function decodeWav(buffer: ArrayBuffer): WavData {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44) throw new Error("bad wav");
  if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== "RIFF") {
    throw new Error("not RIFF");
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataOffset = 44; // assume canonical header (our encoder always writes 44)
  const dataSize = view.getUint32(40, true);
  const samples = new Float32Array(dataSize / 2);
  for (let i = 0; i < samples.length; i++) {
    const v = view.getInt16(dataOffset + i * 2, true);
    samples[i] = v / 32768;
  }
  void bitsPerSample;
  return { samples, sampleRate, channels };
}

export interface VoiceRecorder {
  stop: () => Promise<{ b64: string; durationSecs: number; sampleRate: number; bytes: Uint8Array }>;
  cancel: () => void;
  isRecording: () => boolean;
}

/** Start recording microphone as float PCM. Must be called from a user gesture. */
export async function startVoiceRecorder(
  opts: { onTick?: (secs: number) => void; sampleRate?: number } = {},
): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: opts.sampleRate || 16000 });
  } catch {
    ctx = new AudioContext(); // Safari/WKWebView: constructor options unsupported
  }
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0; // keep the graph audible so onaudioprocess keeps firing, without echo
  const chunks: Float32Array[] = [];
  let recording = true;
  let startAt = Date.now();

  processor.onaudioprocess = (e) => {
    if (!recording) return;
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  const tick = opts.onTick;
  const timer = tick ? setInterval(() => tick(Math.floor((Date.now() - startAt) / 1000)), 500) : null;

  const finalize = () => {
    recording = false;
    if (timer) clearInterval(timer);
    const samples = concatFloat32(chunks);
    const durationSecs = samples.length / ctx.sampleRate;
    const wav = encodeWav(samples, ctx.sampleRate, 1);
    const bytes = new Uint8Array(wav);
    let b64 = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    b64 = btoa(b64);
    return { b64, durationSecs, sampleRate: ctx.sampleRate, bytes };
  };

  const cleanup = () => {
    try { source.disconnect(); } catch {}
    try { processor.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { void ctx.close(); } catch {}
  };

  return {
    stop: async () => {
      const result = finalize();
      cleanup();
      return result;
    },
    cancel: () => {
      recording = false;
      cleanup();
    },
    isRecording: () => recording,
  };
}

/** Encode an ArrayBuffer as base64 (chunked to avoid call-stack overflow). */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let b64 = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    b64 += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(b64);
}
