import { useCallback, useRef, useState } from "react";
import { apiWsUrl } from "../lib/api";
import { base64ToBytes, bytesToBase64, mulawToPcm16, pcm16ToMulaw, resamplePcm16 } from "../lib/audio-codec";

const WIRE_SAMPLE_RATE = 8000; // matches connectStt/connectTts's mu-law assumption, see test-call-stream.ts
const CAPTURE_BUFFER_SIZE = 4096;

export type VoiceTestCallStatus = "idle" | "connecting" | "listening" | "speaking" | "ended" | "error";

export type VoiceTestCallTranscriptEntry = { role: "caller" | "agent"; text: string };

/** One simulated mid-call provider switch (Phase 3, 2026-07-17) — only ever
 * sent when the caller opted into "Simulate provider failure"; see
 * test-call-stream.ts's wire-format doc comment. */
export type VoiceTestCallFailoverEvent = { channel: "stt" | "tts"; from: string; to: string };

type ServerEvent =
  | { type: "ready" }
  | { type: "audio"; audio: string }
  | { type: "transcript"; role: "caller" | "agent"; text: string }
  | { type: "clear" }
  | { type: "failover"; simulated: boolean; channel: "stt" | "tts"; from: string; to: string }
  | { type: "ended"; reason?: string }
  | { type: "error"; message?: string };

/**
 * Full-duplex mic-in/agent-voice-out for the Preview drawer's Voice tab
 * (AGENT-CONSOLE-UI-PLAN.md Phase 2) — talks to the real backend pipeline
 * via voice/test-call-stream.ts, not decorative frontend. See that file's
 * header comment for the exact wire protocol this hook speaks.
 *
 * Two-step auth handshake (browser WebSocket can't send custom headers):
 * `tokenFetchFn` POSTs to the already-session/admin-key-authed token route
 * (returns `{ token }`), then this opens the WS with that token as a query
 * param — see voice/test-call-tokens.ts.
 */
export function useVoiceTestCall(tokenFetchFn: () => Promise<Response>) {
  const [status, setStatus] = useState<VoiceTestCallStatus>("idle");
  const [transcripts, setTranscripts] = useState<VoiceTestCallTranscriptEntry[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failoverEvents, setFailoverEvents] = useState<VoiceTestCallFailoverEvent[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const playbackGainRef = useRef<GainNode | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const meterRafRef = useRef<number | null>(null);
  const cleanupGuardRef = useRef(false);

  const stopMeterLoop = useCallback(() => {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
  }, []);

  const startMeterLoop = useCallback(() => {
    const micData = new Uint8Array(micAnalyserRef.current?.frequencyBinCount ?? 0);
    const playbackData = new Uint8Array(playbackAnalyserRef.current?.frequencyBinCount ?? 0);

    function tick() {
      if (micAnalyserRef.current && micData.length) {
        micAnalyserRef.current.getByteFrequencyData(micData);
        const avg = micData.reduce((sum, v) => sum + v, 0) / micData.length;
        setMicLevel(Math.min(1, avg / 128));
      }
      if (playbackAnalyserRef.current && playbackData.length) {
        playbackAnalyserRef.current.getByteFrequencyData(playbackData);
        const avg = playbackData.reduce((sum, v) => sum + v, 0) / playbackData.length;
        setAgentLevel(Math.min(1, avg / 128));
      }
      meterRafRef.current = requestAnimationFrame(tick);
    }
    tick();
  }, []);

  const cleanup = useCallback((finalStatus: VoiceTestCallStatus) => {
    if (cleanupGuardRef.current) return;
    cleanupGuardRef.current = true;

    stopMeterLoop();
    setMicLevel(0);
    setAgentLevel(0);

    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    activeSourcesRef.current = [];

    processorRef.current?.disconnect();
    processorRef.current = null;
    micSourceRef.current?.disconnect();
    micSourceRef.current = null;
    micAnalyserRef.current?.disconnect();
    micAnalyserRef.current = null;
    playbackGainRef.current?.disconnect();
    playbackGainRef.current = null;
    playbackAnalyserRef.current?.disconnect();
    playbackAnalyserRef.current = null;

    for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
    micStreamRef.current = null;

    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      void audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch {
        // ignore
      }
    }
    wsRef.current?.close();
    wsRef.current = null;

    setStatus(finalStatus);
  }, [stopMeterLoop]);

  const playAgentAudio = useCallback((base64Mulaw: string) => {
    const ctx = audioCtxRef.current;
    const gain = playbackGainRef.current;
    if (!ctx || !gain) return;

    const mulaw = base64ToBytes(base64Mulaw);
    const pcm8k = mulawToPcm16(mulaw);
    const pcmAtCtxRate = resamplePcm16(pcm8k, WIRE_SAMPLE_RATE, ctx.sampleRate);

    const float32 = new Float32Array(pcmAtCtxRate.length);
    for (let i = 0; i < pcmAtCtxRate.length; i++) float32[i] = pcmAtCtxRate[i]! / 32768;

    const buffer = ctx.createBuffer(1, float32.length, ctx.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + buffer.duration;

    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };
  }, []);

  const clearPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    activeSourcesRef.current = [];
    if (audioCtxRef.current) nextPlayTimeRef.current = audioCtxRef.current.currentTime;
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "listening" || status === "speaking") return;
    cleanupGuardRef.current = false;
    setErrorMessage(null);
    setTranscripts([]);
    setFailoverEvents([]);
    setStatus("connecting");

    try {
      const tokenRes = await tokenFetchFn();
      if (!tokenRes.ok) throw new Error(`Failed to start test call (${tokenRes.status})`);
      const { token } = (await tokenRes.json()) as { token: string };
      if (!token) throw new Error("No token returned");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      audioCtxRef.current = ctx;
      nextPlayTimeRef.current = ctx.currentTime;

      const micSource = ctx.createMediaStreamSource(stream);
      micSourceRef.current = micSource;

      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      micSource.connect(micAnalyser);
      micAnalyserRef.current = micAnalyser;

      const playbackGain = ctx.createGain();
      const playbackAnalyser = ctx.createAnalyser();
      playbackAnalyser.fftSize = 256;
      playbackGain.connect(playbackAnalyser);
      playbackAnalyser.connect(ctx.destination);
      playbackGainRef.current = playbackGain;
      playbackAnalyserRef.current = playbackAnalyser;

      const ws = new WebSocket(apiWsUrl(`/api/voice/test-call?token=${encodeURIComponent(token)}`));
      wsRef.current = ws;

      const processor = ctx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      micSource.connect(processor);
      // ScriptProcessorNode only fires onaudioprocess while connected into the
      // graph's destination — this doesn't route mic audio to the speakers
      // (that would be feedback), it just needs to be "live" for Chrome/Safari.
      processor.connect(ctx.destination);
      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]!));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const resampled = resamplePcm16(pcm16, ctx.sampleRate, WIRE_SAMPLE_RATE);
        const mulaw = pcm16ToMulaw(resampled);
        ws.send(JSON.stringify({ type: "media", audio: bytesToBase64(mulaw) }));
      };

      ws.onopen = () => {
        startMeterLoop();
      };
      ws.onmessage = (event) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (data.type) {
          case "ready":
            setStatus("listening");
            break;
          case "audio":
            setStatus("speaking");
            playAgentAudio(data.audio);
            break;
          case "clear":
            clearPlayback();
            break;
          case "failover":
            setFailoverEvents((prev) => [...prev, { channel: data.channel, from: data.from, to: data.to }]);
            break;
          case "transcript":
            setTranscripts((prev) => [...prev, { role: data.role, text: data.text }]);
            if (data.role === "caller") setStatus("listening");
            break;
          case "ended":
            cleanup("ended");
            break;
          case "error":
            setErrorMessage(data.message ?? "Test call failed");
            cleanup("error");
            break;
        }
      };
      ws.onerror = () => {
        setErrorMessage("Connection to the test call failed");
        cleanup("error");
      };
      ws.onclose = () => {
        cleanup("ended");
      };
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start test call");
      cleanup("error");
    }
  }, [status, tokenFetchFn, playAgentAudio, clearPlayback, cleanup, startMeterLoop]);

  const stop = useCallback(() => {
    cleanup("idle");
  }, [cleanup]);

  return { status, transcripts, micLevel, agentLevel, errorMessage, failoverEvents, start, stop };
}
