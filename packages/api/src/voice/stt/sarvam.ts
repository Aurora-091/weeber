import type { ConnectStt } from "./types";
import { mulawChunkToWavBase64 } from "../audio-codec";

/**
 * Thin wrapper around Sarvam's live streaming STT WebSocket (Saaras v3),
 * for Indian-language transcription Deepgram doesn't cover as well.
 *
 * Unlike Deepgram/Cartesia/ElevenLabs, Sarvam's streaming endpoint does not
 * accept mu-law input at all (wav/pcm only — see docs.sarvam.ai) — so every
 * Twilio mu-law chunk is decoded to PCM16 and wrapped in a WAV header before
 * being sent (see ../audio-codec.ts). This is the one provider in this
 * codebase that needs that conversion.
 *
 * No reconnect loop here (unlike Deepgram) — Sarvam's own long-lived-socket
 * guidance is a client-side concern for very long idle gaps, which a live
 * call turn doesn't hit. An unexpected close surfaces via onFatalError so
 * the call ends cleanly instead of hanging on dead audio.
 */
const SAMPLE_RATE = 8000;

/** ISO-ish agent-frame language code -> Sarvam's BCP-47 `language-code` query param.
 * Sarvam has no single-code "auto for all" — "unknown" triggers its own
 * language-detection mode, used here when no language is configured. */
function toSarvamLanguageCode(language?: string): string {
  if (!language || language === "en") return "en-IN";
  if (language === "multi" || language === "unknown") return "unknown";
  if (language.includes("-")) return language; // already BCP-47, e.g. caller passed "hi-IN" directly
  return `${language}-IN`;
}

// No reconnect loop (see module doc comment above) — onStatsUpdate has
// nothing to report here, unlike Deepgram's bounded-retry implementation.
export const connectSarvamStt: ConnectStt = (onTranscript, onFatalError, _onStatsUpdate, onConnected, language) => {
  const apiKey = process.env.SARVAM_API_KEY ?? "";
  const languageCode = toSarvamLanguageCode(language);
  const params = new URLSearchParams({
    "language-code": languageCode,
    model: "saaras:v3",
    mode: "transcribe",
    sample_rate: String(SAMPLE_RATE),
    input_audio_codec: "pcm_s16le",
    high_vad_sensitivity: "true",
    vad_signals: "true",
  });

  const stats = { reconnectCount: 0, totalGapMs: 0 };
  const connectRequestedAt = Date.now();
  let hasReportedInitialConnect = false;
  let isOpen = false;
  let closedIntentionally = false;

  // Sarvam auth is a plain `Api-Subscription-Key` header (not a subprotocol
  // token like Deepgram) — Bun's `WebSocket` supports passing headers
  // directly in the constructor as a Bun-specific extension (doesn't work
  // in browsers, fine here since this only ever runs server-side).
  const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
    headers: { "Api-Subscription-Key": apiKey },
  } as unknown as string[]);

  ws.addEventListener("open", () => {
    isOpen = true;
    if (!hasReportedInitialConnect) {
      hasReportedInitialConnect = true;
      onConnected?.(Date.now() - connectRequestedAt);
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "data" && msg.data?.transcript) {
        // Sarvam's streaming STT returns one "data" message per
        // VAD-detected utterance (not per-token like Deepgram's interim
        // results) — treat every transcript message as final.
        onTranscript({ text: String(msg.data.transcript), isFinal: true, speechFinal: true });
      }
      // msg.type === "events" (speech_start/speech_end via vad_signals) is
      // available for future barge-in wiring but not consumed yet — the
      // existing barge-in logic in stream.ts keys off transcript text
      // arriving, which works the same regardless of STT provider.
      if (msg.type === "error") {
        console.error("[sarvam-stt] server error", msg);
      }
    } catch (err) {
      console.error("[sarvam-stt] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[sarvam-stt] socket error", err);
    if (!closedIntentionally) onFatalError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    isOpen = false;
    if (!closedIntentionally) {
      console.warn("[sarvam-stt] connection closed unexpectedly", evt.code, evt.reason);
      onFatalError?.(new Error(`Sarvam STT socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendAudio(chunk: Uint8Array) {
      if (!isOpen || ws.readyState !== WebSocket.OPEN) return;
      const wavBase64 = mulawChunkToWavBase64(chunk, SAMPLE_RATE);
      ws.send(JSON.stringify({ audio: { data: wavBase64, sample_rate: String(SAMPLE_RATE), encoding: "audio/wav" } }));
    },
    getStats() {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "flush" }));
        ws.close();
      }
    },
  };
};
