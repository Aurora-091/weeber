import type { ConnectTts, ConnectTtsSession, TtsSession } from "./types";
import { resolveVoiceId } from "./default-voices";

/**
 * Thin wrapper around ElevenLabs' streaming TTS WebSocket, configured to
 * output mu-law 8kHz audio so it can be forwarded straight into a Twilio
 * Media Stream `media` event with zero re-encoding.
 *
 * Phase C1 (2026-08-24): switched from the single-context `/stream-input`
 * endpoint (one connection per turn, by construction — sending an empty
 * `{text: ""}` ends that socket's only stream) to the `/multi-stream-input`
 * endpoint, which multiplexes independent `context_id`s over one socket —
 * ElevenLabs' own recommended way to reuse a connection across turns
 * (docs: "Multi-Context WebSockets... generating audio from text input
 * while managing multiple independent audio generation streams (contexts)
 * over a single WebSocket connection"). `connectElevenLabsSession` opens the
 * socket once per call; `startTurn` opens a fresh context on it. Note the
 * server's audio/final messages key off `contextId` (camelCase) while the
 * client's own messages use `context_id` (snake_case) — that's ElevenLabs'
 * own asymmetry, not a typo here.
 *
 * `connectElevenLabsTts` (the original one-shot shape) still backs
 * tts-preview.ts's single-clip "preview this voice" button, which has
 * nothing to reuse a socket across — derived from the session below so the
 * wire protocol lives in exactly one place.
 *
 * Hindi/Hinglish research (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * `language_code` is a real, documented query param on this endpoint (the
 * ISO 639-1 language code) that enforces/hints the target language for
 * multilingual-capable models like eleven_flash_v2_5. Omitted (falls back to
 * the model's own detection) when no language is configured for the call.
 *
 * Phase 3 (2026-07-16): optional pronunciation dictionary support, sent in
 * each context's init message (ElevenLabs: "must only be provided in the
 * first message" — for multi-context that means the first message *of each
 * context*, not just the socket's first message ever). Configured via
 * `ELEVENLABS_PRONUNCIATION_DICTIONARY_ID` + `_VERSION_ID` (both required
 * together). Omitted entirely when unset.
 */
export const connectElevenLabsSession: ConnectTtsSession = (voiceIdOverride, language, onConnected) => {
  const connectRequestedAt = Date.now();
  const voiceId = resolveVoiceId("elevenlabs", voiceIdOverride);
  const dictionaryId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_ID;
  const dictionaryVersionId = process.env.ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID;
  // "multi" is Deepgram STT's own code-switching mode (agent-frame.ts's
  // RECOMMENDED_LANGUAGES) — not a real ISO 639-1 language, so it's never
  // valid to forward as ElevenLabs' language_code.
  const languageParam = language && language !== "multi" ? `&language_code=${encodeURIComponent(language)}` : "";
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input` +
    `?model_id=eleven_flash_v2_5&output_format=ulaw_8000${languageParam}`;

  const ws = new WebSocket(url);
  let closedIntentionally = false;
  let connectedFired = false;

  let current:
    | {
        contextId: string;
        onAudioChunk: (base64Audio: string) => void;
        onDone?: () => void;
        onError?: (err: unknown) => void;
        finished: boolean;
        initialized: boolean;
      }
    | undefined;

  function send(payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  ws.addEventListener("open", () => {
    if (!connectedFired) {
      connectedFired = true;
      onConnected?.(Date.now() - connectRequestedAt);
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      const turn = current;
      if (!turn || msg.contextId !== turn.contextId) return;
      if (msg.audio) turn.onAudioChunk(msg.audio as string);
      if (msg.isFinal) {
        turn.finished = true;
        turn.onDone?.();
      }
    } catch (err) {
      console.error("[elevenlabs] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[elevenlabs] socket error", err);
    if (current && !current.finished && !closedIntentionally) current.onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (current && !current.finished && !closedIntentionally) {
      console.warn("[elevenlabs] connection closed before turn finished", evt.code, evt.reason);
      current.onError?.(new Error(`ElevenLabs socket closed unexpectedly (code ${evt.code})`));
    }
  });

  const session: TtsSession = {
    startTurn(onAudioChunk, onDone, onError) {
      const contextId = `vent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      current = { contextId, onAudioChunk, onDone, onError, finished: false, initialized: false };

      function ensureInitialized() {
        if (current?.initialized) return;
        if (current) current.initialized = true;
        // Initial per-context handshake — required before any real text on
        // THIS context, same "must be a single space first" contract as the
        // old single-context endpoint, just scoped to a context_id now.
        send({
          text: " ",
          context_id: contextId,
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          xi_api_key: process.env.ELEVENLABS_API_KEY,
          ...(dictionaryId && dictionaryVersionId
            ? {
                pronunciation_dictionary_locators: [
                  { pronunciation_dictionary_id: dictionaryId, version_id: dictionaryVersionId },
                ],
              }
            : {}),
        });
      }

      return {
        sendText(text: string) {
          ensureInitialized();
          send({ text: `${text} `, context_id: contextId, flush: false });
        },
        endTurn() {
          ensureInitialized();
          // close_context flushes remaining audio and tears down just this
          // context — the socket itself stays open for the next turn.
          send({ context_id: contextId, close_context: true });
        },
        close() {
          // Barge-in / abort: no documented way to cancel a single context
          // mid-generation, and closing the whole socket on interrupt is
          // what every provider here does — the next turn reconnects
          // transparently either way.
          closedIntentionally = true;
          ws.close();
        },
      };
    },
    isOpen() {
      // Live off the socket, not an event-driven flag — see cartesia.ts's
      // isOpen for why (a reused session's socket could already be CLOSED
      // before the "close" event has actually dispatched to this listener).
      return ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING;
    },
    close() {
      closedIntentionally = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          send({ close_socket: true });
        } catch {
          // best-effort — closing the raw socket below still tears it down
        }
      }
      ws.close();
    },
  };
  return session;
};

export const connectElevenLabsTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, language, _onWordTimestamp, onConnected) => {
  const session = connectElevenLabsSession(voiceIdOverride, language, onConnected);
  const turn = session.startTurn(onAudioChunk, onDone, onError);
  return {
    ...turn,
    close() {
      turn.close();
      session.close();
    },
  };
};
