/**
 * Common interface every STT provider implements, so the call-handling
 * pipeline (stream.ts) never needs to know which provider is active — same
 * pattern as tts/types.ts. Add a new provider by implementing this shape
 * and registering it in `stt/index.ts`.
 */
export type SttTranscriptHandler = (params: {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  /** SOTA-fix-marathon Phase 0.2 (2026-08-16): which signal actually ended
   * this turn — Deepgram's real `speech_final` (~300ms endpointing wait) or
   * the synthetic `UtteranceEnd` VAD fallback (~1000ms). Both previously set
   * `speechFinal: true` identically, so the two were indistinguishable
   * downstream despite differing by up to 700ms (audit-13 §5.1). Undefined
   * on providers with no such dual-signal concept (Sarvam, ElevenLabs). */
  endpointSignal?: "speech_final" | "utterance_end";
}) => void;

export type SttStats = {
  reconnectCount: number;
  totalGapMs: number;
};

export type SttConnection = {
  sendAudio(chunk: Uint8Array): void;
  getStats(): SttStats;
  close(): void;
};

export type SttProvider = "deepgram" | "sarvam" | "elevenlabs";

export type ConnectStt = (
  onTranscript: SttTranscriptHandler,
  onFatalError?: (err: unknown) => void,
  onStatsUpdate?: (stats: SttStats) => void,
  onConnected?: (ms: number) => void,
  /** BCP-47-ish language code from the agent frame (agent-frame.ts's
   * `language`), e.g. "hi", "mr", "ta", "en", or "multi" for
   * auto-detect/code-switching where the provider supports it. Undefined
   * falls back to the provider's own default (English). Each provider
   * adapter normalizes this into whatever format it actually needs (see
   * stt/index.ts's `normalizeLanguageForProvider`). */
  language?: string,
) => SttConnection;
