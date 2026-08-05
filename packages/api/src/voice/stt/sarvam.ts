import type { ConnectStt } from "./types";
import { mulawChunkToPcm16Base64 } from "../audio-codec";

/**
 * Thin wrapper around Sarvam's live streaming STT WebSocket (Saaras v3),
 * for Indian-language transcription Deepgram doesn't cover as well.
 *
 * Unlike Deepgram/Cartesia/ElevenLabs, Sarvam's streaming endpoint does not
 * accept mu-law input at all (wav/pcm only — see docs.sarvam.ai) — so every
 * Twilio mu-law chunk is decoded to PCM16 before being sent (see
 * ../audio-codec.ts). This is the one provider in this codebase that needs
 * that conversion.
 *
 * WIRE FORMAT (2026-08-05, ADR-072 — do not "simplify" any of this without
 * re-running the probe described in the ADR). All four combinations below were
 * tested against a real Sarvam account with real 8kHz mu-law Hinglish audio,
 * streamed in 160-byte/20ms frames exactly as Twilio delivers it:
 *   - `input_audio_codec=pcm_s16le` + a 44-byte WAV header on every frame
 *     (what this adapter used to send): Sarvam returns **no transcript and no
 *     error at all** — a silently deaf call. This was the root cause of the
 *     "Hindi agent is not listening" defect.
 *   - `input_audio_codec=wav` + a WAV header on every frame: also silent.
 *   - raw PCM16LE with the per-frame `sample_rate`/`encoding` fields omitted:
 *     Sarvam rejects it — "2 validation errors ... audio.encoding Field
 *     required". Both fields are mandatory even though the connection-level
 *     params supersede them.
 *   - raw PCM16LE **with** `sample_rate: "8000"` and `encoding: "audio/wav"`
 *     still present: correct code-mixed transcript. This is what we send.
 * So `encoding: "audio/wav"` is a required-but-ignored legacy field here, not
 * a description of the bytes — the bytes are bare PCM16LE and the
 * connection-level `input_audio_codec`/`sample_rate` are what actually govern
 * decoding. Sarvam's own AsyncAPI spec marks the per-message `sample_rate` as
 * legacy with no legal 8kHz value ("8kHz is only supported via connection
 * parameter"), yet the server's validator requires the field regardless;
 * sending "8000" anyway is what works in practice.
 *
 * Audio arriving before the socket opens is buffered (bounded) and flushed on
 * open, same as stt/deepgram.ts — Sarvam's connect took ~900ms in testing
 * (vs Deepgram's ~130ms), so dropping those frames would clip the start of
 * whatever the caller said first.
 *
 * No reconnect loop here (unlike Deepgram) — Sarvam's own long-lived-socket
 * guidance is a client-side concern for very long idle gaps, which a live
 * call turn doesn't hit. An unexpected close, or a server-side `error`
 * message, surfaces via onFatalError so stream.ts can fail over to another
 * STT provider instead of leaving the call deaf.
 *
 * mode="codemix" (2026-07-16, docs/voice-quality/hindi-hinglish-voice-support.md,
 * live-verified): Sarvam's `saaras:v3` exposes a `mode` param — `transcribe`
 * (native-script-only) was the previous default here. Live-tested both with
 * a real Sarvam account and the same synthesized Hinglish audio used to
 * verify the ElevenLabs adapter ("मुझे एक flight book करनी है और मेरा order
 * भी confirm करना है।"): `transcribe` mode phonetically transliterated the
 * English loanwords into Devanagari ("order" -> "ऑर्डर", "confirm" ->
 * "कन्फर्म"); `codemix` kept them in Latin script ("order", "confirm"),
 * matching Sarvam's own docs guidance verbatim — "Use codemix for
 * chat/agent transcripts that feel natural, transcribe for clean
 * native-script records." A live voice agent is squarely the "chat/agent
 * transcript" case, not the archival-record case, so codemix is the
 * correct default here, not Hindi-specific (Sarvam's own framing is
 * English-loanword handling generally, not a Hindi-only feature).
 */
const SAMPLE_RATE = 8000;

// ~2s of 8kHz mu-law (1 byte/sample) held while the socket is still opening —
// same bound as stt/deepgram.ts's reconnect buffer.
const MAX_BUFFERED_BYTES = 16_000;

/** Every value Sarvam's `language-code` param accepts, quoted from the server's
 * own validation error (it enumerates the whole enum when you send a bad code):
 * "Input should be 'unknown', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN',
 * 'od-IN', 'pa-IN', 'ta-IN', 'te-IN', 'en-IN', 'gu-IN', 'as-IN', 'ur-IN',
 * 'ne-IN', 'kok-IN', ...". Anything outside it is rejected mid-stream with an
 * `error` message and the socket is closed — a deaf call, so we never send a
 * code we can't find here. */
const SARVAM_LANGUAGE_CODES = new Set([
  "unknown",
  "en-IN",
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "as-IN",
  "ur-IN",
  "ne-IN",
  "kok-IN",
  "ks-IN",
  "sd-IN",
  "sa-IN",
  "sat-IN",
  "mni-IN",
  "brx-IN",
  "mai-IN",
  "doi-IN",
]);

/** ISO-ish agent-frame language code -> Sarvam's BCP-47 `language-code` query param.
 * Sarvam has no single-code "auto for all" — "unknown" triggers its own
 * language-detection mode, used here when no language is configured, for
 * "multi", and as the fallback for any code Sarvam doesn't accept (verified:
 * "unknown" transcribes the same Hinglish audio correctly, so falling back to
 * it degrades gracefully instead of killing the socket).
 *
 * "hinglish" is a shipped RECOMMENDED_LANGUAGES option with no Sarvam code of
 * its own — it maps to hi-IN, whose `codemix` mode is exactly the code-mix
 * case. This mirrors tts/sarvam.ts's own toSarvamLanguageCode. Until
 * 2026-08-05 this function derived `${language}-IN` blindly and produced
 * "hinglish-IN", which Sarvam rejects — a guaranteed-deaf Hinglish agent
 * (ADR-072). */
export function toSarvamLanguageCode(language?: string): string {
  if (!language) return "en-IN";
  const lang = language.toLowerCase();
  if (lang === "en") return "en-IN";
  if (lang === "multi" || lang === "unknown") return "unknown";
  if (lang === "hinglish") return "hi-IN";
  const candidate = lang.includes("-")
    ? lang.replace(/-([a-z]{2,3})$/, (_match, region: string) => `-${region.toUpperCase()}`)
    : `${lang}-IN`;
  if (SARVAM_LANGUAGE_CODES.has(candidate)) return candidate;
  console.warn(`[sarvam-stt] language "${language}" has no Sarvam language-code — falling back to auto-detect ("unknown")`);
  return "unknown";
}

// No reconnect loop (see module doc comment above) — onStatsUpdate has
// nothing to report here, unlike Deepgram's bounded-retry implementation.
export const connectSarvamStt: ConnectStt = (onTranscript, onFatalError, _onStatsUpdate, onConnected, language) => {
  const apiKey = process.env.SARVAM_API_KEY ?? "";
  const languageCode = toSarvamLanguageCode(language);
  const params = new URLSearchParams({
    "language-code": languageCode,
    model: "saaras:v3",
    mode: "codemix",
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
  let fatalReported = false;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;

  function reportFatal(err: unknown) {
    if (closedIntentionally || fatalReported) return;
    fatalReported = true;
    onFatalError?.(err);
  }

  // Sarvam auth is a plain `Api-Subscription-Key` header (not a subprotocol
  // token like Deepgram) — Bun's `WebSocket` supports passing headers
  // directly in the constructor as a Bun-specific extension (doesn't work
  // in browsers, fine here since this only ever runs server-side).
  const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
    headers: { "Api-Subscription-Key": apiKey },
  } as unknown as string[]);

  function sendFrame(chunk: Uint8Array) {
    ws.send(
      JSON.stringify({
        audio: {
          data: mulawChunkToPcm16Base64(chunk),
          // Required by Sarvam's request validator even though the
          // connection-level params are what actually apply — see the wire
          // format note in the module doc above.
          sample_rate: String(SAMPLE_RATE),
          encoding: "audio/wav",
        },
      }),
    );
  }

  ws.addEventListener("open", () => {
    isOpen = true;
    if (!hasReportedInitialConnect) {
      hasReportedInitialConnect = true;
      onConnected?.(Date.now() - connectRequestedAt);
    }
    // Flush whatever the caller said while we were still connecting.
    const buffered = pending.splice(0);
    pendingBytes = 0;
    for (const chunk of buffered) {
      if (ws.readyState === WebSocket.OPEN) sendFrame(chunk);
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
        // Sarvam reports a bad request (unsupported language-code, malformed
        // audio payload) as an `error` message and then usually closes. Left
        // as a bare console.error until 2026-08-05, which meant the call
        // stayed up and permanently deaf; escalate so stream.ts fails over to
        // another STT provider instead (ADR-072).
        const detail = msg.data?.message ?? msg.message ?? JSON.stringify(msg);
        console.error("[sarvam-stt] server error", msg);
        reportFatal(new Error(`Sarvam STT server error: ${String(detail).slice(0, 300)}`));
      }
    } catch (err) {
      console.error("[sarvam-stt] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[sarvam-stt] socket error", err);
    reportFatal(err);
  });

  ws.addEventListener("close", (evt) => {
    isOpen = false;
    if (!closedIntentionally && !fatalReported) {
      console.warn("[sarvam-stt] connection closed unexpectedly", evt.code, evt.reason);
      reportFatal(new Error(`Sarvam STT socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendAudio(chunk: Uint8Array) {
      if (isOpen && ws.readyState === WebSocket.OPEN) {
        sendFrame(chunk);
        return;
      }
      if (closedIntentionally || fatalReported) return;
      // Still connecting: hold a bounded tail of audio rather than dropping it.
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      while (pendingBytes > MAX_BUFFERED_BYTES && pending.length > 0) {
        pendingBytes -= pending.shift()!.byteLength;
      }
    },
    getStats() {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      pending.length = 0;
      pendingBytes = 0;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "flush" }));
        ws.close();
      }
    },
  };
};
