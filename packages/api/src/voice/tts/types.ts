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
  /**
   * Cartesia context cancel (ADR-126). Optional: send `{ cancel: true }`
   * for this turn's context_id so Sonic drops unstarted generation before
   * `close()` tears the socket down. Providers without a cancel message omit
   * this; callers use `tts?.cancel?.()` then `close()`.
   */
  cancel?(): void;
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
