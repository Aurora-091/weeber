import type { ConnectTts, ConnectTtsSession, TtsSession } from "./types";
import { resolveVoiceId } from "./default-voices";

/**
 * Thin wrapper around Cartesia's streaming TTS WebSocket (Sonic model),
 * configured to output mu-law 8kHz audio directly — same zero-re-encoding
 * path as ElevenLabs, so it drops straight into a Twilio Media Stream.
 *
 * Uses Cartesia's "continuation" flow: all text chunks for one agent turn
 * share a single `context_id`, sent with `continue: true` until the turn
 * ends, at which point a final empty-transcript message with
 * `continue: false` flushes and closes out that context.
 *
 * Phase C1 (2026-08-24): Cartesia's own protocol already multiplexes
 * independent contexts over one socket — a `context_id` was always per-turn,
 * it just used to live on a connection that was ALSO per-turn. This file now
 * separates the two: `connectCartesiaSession` opens the socket once and
 * `startTurn` only mints a fresh `context_id`, so a multi-turn call pays the
 * ~200-270ms handshake exactly once instead of on every turn (audit finding,
 * docs/plans/phase-c-latency.md). `connectCartesiaTts` (the original
 * one-shot shape, still used by tts-preview.ts's single-clip "preview this
 * voice" button) is now a thin wrapper: one session, one turn, close both
 * together.
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
export const connectCartesiaSession: ConnectTtsSession = (voiceIdOverride, language, onConnected) => {
  const apiKey = process.env.CARTESIA_API_KEY ?? "";
  const voiceId = resolveVoiceId("cartesia", voiceIdOverride);
  const cartesiaLanguage = language && language !== "multi" ? language : undefined;
  const cartesiaVersion = "2025-11-04";
  const url = `wss://api.cartesia.ai/tts/websocket?api_key=${encodeURIComponent(apiKey)}&cartesia_version=${cartesiaVersion}`;

  const connectRequestedAt = Date.now();
  const ws = new WebSocket(url);
  let opened = false;
  let closedIntentionally = false;
  let connectedFired = false;
  const pendingSends: string[] = [];

  // The turn currently allowed to receive callbacks — swapped by startTurn().
  // A message tagged with any other context_id (a turn that already ended,
  // or — should the two ever briefly overlap — the next one starting) is
  // dropped rather than misrouted. Only one turn is ever active at a time in
  // this codebase's usage (stream.ts awaits a turn's completion before the
  // next begins), so this is a safety net, not a load-bearing assumption.
  let current:
    | {
        contextId: string;
        onAudioChunk: (base64Audio: string) => void;
        onDone?: () => void;
        onError?: (err: unknown) => void;
        onWordTimestamp?: (word: string, startMs: number, endMs: number) => void;
        finished: boolean;
      }
    | undefined;

  function send(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      pendingSends.push(json);
    }
  }

  ws.addEventListener("open", () => {
    opened = true;
    if (!connectedFired) {
      connectedFired = true;
      onConnected?.(Date.now() - connectRequestedAt);
    }
    for (const json of pendingSends.splice(0)) ws.send(json);
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      const turn = current;
      if (!turn || msg.context_id !== turn.contextId) return;
      if (msg.type === "chunk" && (msg.data || msg.audio)) turn.onAudioChunk((msg.data ?? msg.audio) as string);
      // Word-level timing (add_timestamps: true below) — see types.ts's
      // onWordTimestamp doc comment for why stream.ts needs this for
      // accurate barge-in context reconstruction. Cartesia sends one
      // "timestamps" message per chunk of words with parallel arrays.
      if (msg.type === "timestamps" && msg.word_timestamps && turn.onWordTimestamp) {
        const { words, start, end } = msg.word_timestamps as { words: string[]; start: number[]; end: number[] };
        for (let i = 0; i < (words?.length ?? 0); i++) {
          turn.onWordTimestamp(words[i], (start[i] ?? 0) * 1000, (end[i] ?? 0) * 1000);
        }
      }
      if (msg.type === "done") {
        turn.finished = true;
        turn.onDone?.();
      }
      if (msg.type === "error") {
        console.error("[cartesia] server error", msg.error ?? msg);
        turn.onError?.(new Error(msg.error ?? "Cartesia TTS error"));
      }
    } catch (err) {
      console.error("[cartesia] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[cartesia] socket error", err);
    if (current && !current.finished && !closedIntentionally) current.onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (current && !current.finished && !closedIntentionally) {
      console.warn("[cartesia] connection closed before turn finished", evt.code, evt.reason);
      current.onError?.(new Error(`Cartesia socket closed unexpectedly (code ${evt.code})`));
    }
  });

  const session: TtsSession = {
    startTurn(onAudioChunk, onDone, onError, onWordTimestamp) {
      const contextId = `vent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let currentEmotion: string | undefined;
      current = { contextId, onAudioChunk, onDone, onError, onWordTimestamp, finished: false };

      function buildPayload(transcript: string, keepOpen: boolean) {
        return {
          context_id: contextId,
          model_id: "sonic-3",
          transcript,
          voice: { mode: "id", id: voiceId },
          ...(cartesiaLanguage ? { language: cartesiaLanguage } : {}),
          output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
          continue: keepOpen,
          add_timestamps: true,
          ...(currentEmotion ? { generation_config: { emotion: currentEmotion } } : {}),
        };
      }

      return {
        sendText(text: string) {
          send(buildPayload(text, true));
        },
        endTurn() {
          send(buildPayload("", false));
        },
        close() {
          // Barge-in / abort: Cartesia has no documented "cancel just this
          // context" message, and every provider here closes the whole
          // socket on interrupt anyway (Sarvam's docs say so explicitly for
          // theirs) — the next turn reconnects transparently either way.
          closedIntentionally = true;
          if (opened) ws.close();
        },
        setTone(tone: string) {
          currentEmotion = tone;
        },
      };
    },
    isOpen() {
      // Read live off the socket rather than an event-driven flag — a flag
      // only updates once the "close" event has actually dispatched, and a
      // reused session's socket could already be CLOSED before that fires.
      // Trusting a stale "still open" flag here would let startTurn's
      // synchronous sendText vanish into a socket that will never flush it
      // and never report an error either.
      return ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING;
    },
    close() {
      closedIntentionally = true;
      if (opened) ws.close();
    },
  };
  return session;
};

/**
 * One-shot shape for callers that want exactly one turn and no reuse — the
 * dashboard's voice-preview button (tts-preview.ts), which is not part of a
 * live call and has nothing to reuse a socket across. Derived from the
 * session above so the wire protocol is defined in exactly one place.
 */
export const connectCartesiaTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, language, onWordTimestamp, onConnected) => {
  const session = connectCartesiaSession(voiceIdOverride, language, onConnected);
  const turn = session.startTurn(onAudioChunk, onDone, onError, onWordTimestamp);
  return {
    ...turn,
    close() {
      turn.close();
      session.close();
    },
  };
};
