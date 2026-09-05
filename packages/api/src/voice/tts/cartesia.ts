import type { ConnectTts } from "./types";
import { resolveVoiceId } from "./default-voices";

/**
 * Managed Cartesia buffering for LLM token streaming (ADR-125).
 * Must be sent on every generation message on a context — Cartesia
 * requires all fields except `transcript` / `continue` / `duration` to
 * stay identical across continuations.
 */
export const CARTESIA_MAX_BUFFER_DELAY_MS = 180;

/**
 * Sonic-3 streams LLM tokens as they arrive. Cartesia's websocket API
 * defaults `max_buffer_delay_ms` to 3000 when the field is omitted — the
 * server holds those tokens until it likes the prosody or the delay
 * elapses. That is the wrong default for a phone agent: a short reply
 * (the 2026-09-05 appointment-setter dead-air turn was 59 chars) can sit
 * in the buffer until the context dies with zero audio bytes, while the
 * transcript still records the line as spoken (ADR-101 / ADR-125).
 *
 * Token streaming is Cartesia's *managed* buffering mode, so we set the
 * delay explicitly and short. 0 would be *custom* buffering, which they
 * tell you to use only when you already aggregate sentences yourself —
 * we do not; we forward LLM deltas. 180ms is enough to gather a word or
 * two for prosody and well under the ~1s context-idle window.
 *
 * `continue: false` on an empty transcript plus `flush: true` is the
 * documented end-of-turn signal when the last token is not known in
 * advance. Both go on `endTurn()`.
 *
 * Uses Cartesia's "continuation" flow: all text chunks for one agent turn
 * share a single `context_id`.
 *
 * Hindi/Hinglish research (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * Cartesia's Generation Request schema (docs.cartesia.ai/api-reference/tts/
 * websocket) documents a top-level `language` field selecting between 40+
 * supported languages/accents — this was previously received from stream.ts
 * (as `_language`) and silently discarded on every call. Omitted (Cartesia
 * falls back to the voice's own default) when no language is configured,
 * same as before this change; "multi" (Deepgram STT's own code-switching
 * mode, not a real language) is never forwarded either.
 */
export const connectCartesiaTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, language, onWordTimestamp, onConnected) => {
  const apiKey = process.env.CARTESIA_API_KEY ?? "";
  const voiceId = resolveVoiceId("cartesia", voiceIdOverride);
  const cartesiaLanguage = language && language !== "multi" ? language : undefined;
  const cartesiaVersion = "2025-11-04";
  const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(apiKey)}&cartesia_version=${cartesiaVersion}`;

  const connectRequestedAt = Date.now();
  const ws = new WebSocket(url);
  const contextId = `vent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let closedIntentionally = false;
  let finished = false;
  let opened = false;
  const pendingSends: string[] = [];
  // Expressive delivery, Tier 1 (2026-07-17, see tone-tags.ts) — set via
  // setTone() below once stream.ts parses the LLM's leading tone tag out of
  // this turn's text, before any of it is sent. Included in every
  // sendText/endTurn message's generation_config for the rest of this
  // turn/connection (one connection per turn, so no cross-turn leakage).
  let currentEmotion: string | undefined;

  function send(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      pendingSends.push(json);
    }
  }

  function generationMessage(transcript: string, continueFlag: boolean, flush: boolean) {
    return {
      context_id: contextId,
      model_id: "sonic-3",
      transcript,
      voice: { mode: "id", id: voiceId },
      ...(cartesiaLanguage ? { language: cartesiaLanguage } : {}),
      output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
      continue: continueFlag,
      max_buffer_delay_ms: CARTESIA_MAX_BUFFER_DELAY_MS,
      add_timestamps: true,
      ...(flush ? { flush: true } : {}),
      ...(currentEmotion ? { generation_config: { emotion: currentEmotion } } : {}),
    };
  }

  ws.addEventListener("open", () => {
    opened = true;
    onConnected?.(Date.now() - connectRequestedAt);
    for (const json of pendingSends.splice(0)) ws.send(json);
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "chunk" && (msg.data || msg.audio)) onAudioChunk((msg.data ?? msg.audio) as string);
      // Word-level timing (add_timestamps: true below) — see types.ts's
      // onWordTimestamp doc comment for why stream.ts needs this for
      // accurate barge-in context reconstruction. Cartesia sends one
      // "timestamps" message per chunk of words with parallel arrays.
      if (msg.type === "timestamps" && msg.word_timestamps && onWordTimestamp) {
        const { words, start, end } = msg.word_timestamps as { words: string[]; start: number[]; end: number[] };
        for (let i = 0; i < (words?.length ?? 0); i++) {
          onWordTimestamp(words[i], (start[i] ?? 0) * 1000, (end[i] ?? 0) * 1000);
        }
      }
      if (msg.type === "done") {
        finished = true;
        onDone?.();
      }
      if (msg.type === "error") {
        console.error("[cartesia] server error", msg.error ?? msg);
        onError?.(new Error(msg.error ?? "Cartesia TTS error"));
      }
    } catch (err) {
      console.error("[cartesia] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[cartesia] socket error", err);
    if (!finished && !closedIntentionally) onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (!finished && !closedIntentionally) {
      console.warn("[cartesia] connection closed before turn finished", evt.code, evt.reason);
      onError?.(new Error(`Cartesia socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendText(text: string) {
      send(generationMessage(text, true, false));
    },
    endTurn() {
      send(generationMessage("", false, true));
    },
    cancel() {
      send({ context_id: contextId, cancel: true });
    },
    close() {
      closedIntentionally = true;
      if (opened) ws.close();
    },
    setTone(tone: string) {
      currentEmotion = tone;
    },
  };
};
