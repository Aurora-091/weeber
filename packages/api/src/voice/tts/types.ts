/**
 * Common interface every TTS provider implements, so the call-handling
 * pipeline (stream.ts) never needs to know which provider is active.
 * Add a new provider by implementing this shape and registering it in
 * `tts/index.ts` — no changes needed anywhere else.
 */
export type TtsConnection = {
  /** Feed a chunk of agent text as it streams from the LLM. */
  sendText(text: string): void;
  /** Signal end of this turn's text so the provider flushes remaining audio. */
  endTurn(): void;
  /** Hard-abort — used on barge-in to stop audio generation immediately. */
  close(): void;
};

export type TtsProvider = "elevenlabs" | "cartesia";

export type ConnectTts = (
  onAudioChunk: (base64Audio: string) => void,
  onDone?: () => void,
  onError?: (err: unknown) => void,
) => TtsConnection;
