import type { ConnectTts } from "./types";

/**
 * Thin wrapper around ElevenLabs' streaming TTS WebSocket ("stream-input"),
 * configured to output mu-law 8kHz audio so it can be forwarded straight into
 * a Twilio Media Stream `media` event with zero re-encoding.
 *
 * One connection is opened per agent turn (see stream.ts), so there's no
 * persistent reconnect here — instead, an unexpected close/error calls
 * `onError` so the caller can end the turn cleanly instead of hanging forever
 * waiting for audio that will never arrive.
 *
 * Hindi/Hinglish research (2026-07-16, docs/hindi-hinglish-voice-support.md):
 * `language_code` is a real, documented query param on this endpoint ("the
 * ISO 639-1 language code, for specific models") that enforces/hints the
 * target language for multilingual-capable models like eleven_flash_v2_5 —
 * this was previously never passed at all despite the ConnectTts type
 * already threading a `language` value through from stream.ts for this
 * exact purpose. Omitted (falls back to the model's own detection) when no
 * language is configured for the call, same as before this change.
 */
export const connectElevenLabsTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, language) => {
  const voiceId = voiceIdOverride || process.env.ELEVENLABS_VOICE_ID;
  // "multi" is Deepgram STT's own code-switching mode (agent-frame.ts's
  // RECOMMENDED_LANGUAGES) — not a real ISO 639-1 language, so it's never
  // valid to forward as ElevenLabs' language_code (a TTS call always speaks
  // one concrete language's phonology, even for a call whose STT side is
  // set to auto-detect across two).
  const languageParam = language && language !== "multi" ? `&language_code=${encodeURIComponent(language)}` : "";
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
    `?model_id=eleven_flash_v2_5&output_format=ulaw_8000${languageParam}`;

  const ws = new WebSocket(url);
  let closedIntentionally = false;
  let finished = false;

  ws.addEventListener("open", () => {
    // Initial handshake message — required before sending any text.
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        xi_api_key: process.env.ELEVENLABS_API_KEY,
      }),
    );
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.audio) onAudioChunk(msg.audio as string);
      if (msg.isFinal) {
        finished = true;
        onDone?.();
      }
    } catch (err) {
      console.error("[elevenlabs] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[elevenlabs] socket error", err);
    if (!finished && !closedIntentionally) onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (!finished && !closedIntentionally) {
      console.warn("[elevenlabs] connection closed before turn finished", evt.code, evt.reason);
      onError?.(new Error(`ElevenLabs socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendText(text: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ text: `${text} `, try_trigger_generation: true }));
      }
    },
    endTurn() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ text: "" }));
    },
    close() {
      closedIntentionally = true;
      ws.close();
    },
  };
};
