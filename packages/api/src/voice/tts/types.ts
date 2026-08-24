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
  /** Expressive delivery, Tier 1 (2026-07-17, see tone-tags.ts) — sets the
   * delivery/emotion for this turn's *remaining* generation, called once
   * per turn as soon as stream.ts has parsed the LLM's leading tone tag out
   * of the text (before any of it is sent via sendText). Optional: a
   * provider with no real emotion control (Sarvam, ElevenLabs today) simply
   * omits this method entirely — callers always invoke it as
   * `tts?.setTone?.(...)`, so an unimplemented provider is a silent no-op,
   * same fail-open convention as onWordTimestamp above. */
  setTone?(tone: string): void;
};

export type TtsProvider = "elevenlabs" | "cartesia" | "sarvam";

/**
 * A persistent provider connection that can serve multiple turns without
 * reopening its socket (Phase C1, 2026-08-24 — docs/plans/phase-c-latency.md).
 * `voiceId`/`language` are fixed for the session's whole life, matching how
 * neither ever changes mid-call. Each provider's own reuse mechanics
 * (Cartesia/ElevenLabs: a fresh context id per turn on one socket; Sarvam:
 * one `config` message, then repeated text/flush cycles) are private to that
 * provider's file — this is the shared shape `tts/index.ts` and `stream.ts`
 * see either way.
 */
export type TtsSession = {
  /** Starts a new turn, reusing the underlying socket. */
  startTurn(
    onAudioChunk: (base64Audio: string) => void,
    onDone?: () => void,
    onError?: (err: unknown) => void,
    onWordTimestamp?: (word: string, startMs: number, endMs: number) => void,
  ): TtsConnection;
  /** False once the underlying socket has closed or errored — the caller
   * (tts/index.ts) must open a fresh session rather than call startTurn on a
   * dead one. Stays true while still connecting (sends queue until open). */
  isOpen(): boolean;
  /** Tears down the underlying socket. Used both at call-end and for a
   * caller barge-in — every provider here treats an interrupt the same way
   * Sarvam's docs say to: close and let the next turn reconnect, rather
   * than trying to cancel a single in-flight turn. */
  close(): void;
};

export type ConnectTtsSession = (
  /** Per-agent voice ID override — falls back to the provider's env-configured default voice when omitted. */
  voiceId?: string,
  /** Per-agent language override — see ConnectTts's `language` param for the full explanation. */
  language?: string,
  /** Fires once, the first time this session's socket actually opens. */
  onConnected?: (ms: number) => void,
) => TtsSession;

export type ConnectTts = (
  onAudioChunk: (base64Audio: string) => void,
  onDone?: () => void,
  onError?: (err: unknown) => void,
  /** Per-agent voice ID override (agent-frame.ts's voiceId) — falls back to
   * the provider's env-configured default voice when omitted. */
  voiceId?: string,
  /** Per-agent language override (agent-frame.ts's language) — Sarvam needs
   * this to pick its target language. ElevenLabs (language_code query param)
   * and Cartesia (top-level `language` field) both also use it, as of the
   * 2026-07-16 Hindi/Hinglish work (docs/hindi-hinglish-voice-support.md),
   * to enforce/hint pronunciation for their multilingual models — previously
   * documented here as ignored by both, which was true in code but not
   * actually correct per either provider's own API (both accept and use it).
   * "multi" (Deepgram STT's own code-switching mode) is never forwarded to
   * any TTS provider — it isn't a real language. */
  language?: string,
  /**
   * Word-level timing, as each word is synthesized — currently only
   * implemented by Cartesia (`add_timestamps: true`). Used by stream.ts's
   * barge-in handling to reconstruct exactly which words the caller
   * actually heard before interrupting, instead of pushing the *entire*
   * generated turn into conversation history regardless of how much of it
   * was ever spoken (the LLM streams faster than TTS speaks, so on
   * interruption the full text is often already generated even though the
   * caller only heard the first few words). Providers without timestamp
   * support simply never call this — stream.ts falls back to its previous
   * full-text behavior when that's the case.
   */
  onWordTimestamp?: (word: string, startMs: number, endMs: number) => void,
  /**
   * SOTA-fix-marathon Phase 0.3 (2026-08-16): fires once, the first time
   * this specific socket opens, with milliseconds since `connectTts` was
   * called — the TTS provider's own connect/handshake cost, isolated from
   * synthesis time. Same shape as STT's `onConnected` (stt/types.ts).
   * Exists to settle audit-13 §3 (P1): whether ADR-083's lazy TTS connect
   * (opening the socket on first text instead of at the top of the turn) is
   * really what pushed Cartesia's first-byte number up — until this,
   * `ttsFirstByteMs` bundled connect time and synthesis time together, so
   * the two candidate causes were unmeasurable apart from each other.
   */
  onConnected?: (ms: number) => void,
) => TtsConnection;
