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
