import type { ConnectStt } from "./types";

/**
 * Thin wrapper around Deepgram's live streaming STT WebSocket, tuned for
 * 8kHz mu-law audio coming straight off a Twilio Media Stream (no re-encoding
 * needed — Deepgram accepts mulaw natively).
 *
 * Includes a bounded auto-reconnect: if the socket drops unexpectedly mid-call
 * (network blip, Deepgram-side hiccup), we transparently reconnect once or
 * twice rather than silently losing transcription for the rest of the call.
 * While reconnecting, incoming audio is buffered (bounded) and flushed the
 * moment the new socket opens, so a brief drop doesn't silently swallow
 * whatever the caller said during the gap — this was the root cause of a
 * mid-call "went blank" incident during testing.
 *
 * Language (2026-08-05, ADR-072): defaults to Deepgram's own default
 * (English) when omitted. Live handshakes against `model=nova-3` accepted the
 * app's shipped Indic codes `hi`, `mr`, `ta`, `te`, `kn`, `bn`, `gu`, `pa`
 * plus `multi`, but rejected `hinglish`, `ml`, and region-suffixed forms like
 * `hi-IN` with HTTP 400. Normalize those before constructing the URL: a bad
 * language param prevents the WebSocket from opening at all, leaving the call
 * deaf until failover exhausts.
 */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;
// ~2s of audio at 8kHz mu-law (1 byte/sample) — enough to cover the typical
// reconnect window without buffering unbounded memory if Deepgram is down.
const MAX_BUFFERED_BYTES = 16_000;

/** Codes `model=nova-3` accepts as a single `language` value, confirmed by live
 * handshake (101 vs 400) rather than from docs — `hinglish` and `ml` are NOT in
 * this set despite both shipping in RECOMMENDED_LANGUAGES. */
const DEEPGRAM_NOVA3_LANGUAGE_CODES = new Set(["hi", "mr", "ta", "te", "kn", "bn", "gu", "pa", "multi"]);

/** agent-frame language code -> a `language` value nova-3 will actually accept,
 * or undefined to omit the param entirely (Deepgram's English default).
 *
 * Anything nova-3 rejects is routed to `multi` (English + one auto-detected
 * other language) instead: degraded recognition beats a socket that never
 * opens. Indic languages Deepgram can't do at all — Malayalam being the one in
 * our own list — are better served by Sarvam, which `resolveSttProvider`
 * already prefers for them whenever SARVAM_API_KEY is set; this path is the
 * no-Sarvam-key fallback. */
export function toDeepgramNova3Language(language?: string): string | undefined {
  if (!language || language.toLowerCase() === "en") return undefined;
  const normalized = language.toLowerCase().split("-")[0]!;
  if (DEEPGRAM_NOVA3_LANGUAGE_CODES.has(normalized)) return normalized;
  console.warn(`[deepgram] language "${language}" is not accepted by nova-3 — using multi-language mode instead`);
  return "multi";
}

export const connectDeepgram: ConnectStt = (onTranscript, onFatalError, onStatsUpdate, onConnected, language) => {
  let ws: WebSocket;
  let closedIntentionally = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isOpen = false;
  let disconnectedAt: number | null = null;
  let hasReportedInitialConnect = false;
  const connectRequestedAt = Date.now();

  const stats = { reconnectCount: 0, totalGapMs: 0 };
  const audioBuffer: Uint8Array[] = [];
  let bufferedBytes = 0;
  // A1b: accumulates `is_final:true` text that hasn't been confirmed done
  // (`speech_final:true`) yet — cleared the moment speech_final fires
  // downstream, or replayed as a synthetic speech_final if `UtteranceEnd`
  // arrives first (Deepgram's VAD-driven fallback for when speech_final
  // itself never fires on a genuinely finished utterance).
  let pendingFinalText = "";

  function bufferAudio(chunk: Uint8Array) {
    audioBuffer.push(chunk);
    bufferedBytes += chunk.byteLength;
    while (bufferedBytes > MAX_BUFFERED_BYTES && audioBuffer.length > 0) {
      const dropped = audioBuffer.shift()!;
      bufferedBytes -= dropped.byteLength;
    }
  }

  function flushBufferedAudio() {
    if (audioBuffer.length === 0) return;
    for (const chunk of audioBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    }
    audioBuffer.length = 0;
    bufferedBytes = 0;
  }

  const params = new URLSearchParams({
    model: "nova-3",
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    vad_events: "true",
    // A1b (VAD/endpointing audit, 2026-07-14): `endpointing` alone is a
    // single fixed-timeout signal — Deepgram's own docs note `speech_final`
    // can occasionally never fire on a genuinely finished utterance (cross-
    // talk, background noise, or audio that trails off below its threshold
    // without a clean stop). `utterance_end_ms` turns on a second, VAD-
    // driven "the caller has definitely stopped" signal (`UtteranceEnd`,
    // handled below) that fires independently of `speech_final` — a safety
    // net, not a replacement. 1000ms is Deepgram's own documented default.
    utterance_end_ms: "1000",
  });
  // Omit entirely for English default — only set when a non-English/"multi"
  // language is actually configured on the agent frame.
  const deepgramLanguage = toDeepgramNova3Language(language);
  if (deepgramLanguage) {
    params.set("language", deepgramLanguage);
  }

  function open() {
    ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [
      "token",
      process.env.DEEPGRAM_API_KEY ?? "",
    ]);

    ws.addEventListener("open", () => {
      isOpen = true;
      reconnectAttempts = 0;
      if (!hasReportedInitialConnect) {
        hasReportedInitialConnect = true;
        onConnected?.(Date.now() - connectRequestedAt);
      }
      if (disconnectedAt) {
        const gap = Date.now() - disconnectedAt;
        stats.totalGapMs += gap;
        disconnectedAt = null;
        console.warn(`[deepgram] reconnected after ${gap}ms gap — flushing ${audioBuffer.length} buffered chunks`);
        onStatsUpdate?.({ ...stats });
      }
      flushBufferedAudio();
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.type === "SpeechStarted") {
          onTranscript({ text: "", isFinal: false, speechFinal: false, vad: "speech_started" });
          return;
        }

        // A1b: VAD-driven fallback for when `speech_final` never fires on a
        // genuinely finished utterance — replay whatever final text has
        // accumulated since the last confirmed speech_final as a synthetic
        // one. No-op if speech_final already handled it (buffer is empty).
        if (msg.type === "UtteranceEnd") {
          if (pendingFinalText.trim()) {
            const text = pendingFinalText.trim();
            pendingFinalText = "";
            onTranscript({ text, isFinal: true, speechFinal: true, endpointSignal: "utterance_end" });
          }
          return;
        }

        if (msg.type !== "Results") return;
        const alt = msg.channel?.alternatives?.[0];
        const text: string = alt?.transcript ?? "";
        const isFinal = Boolean(msg.is_final);
        const speechFinal = Boolean(msg.speech_final);

        // Deepgram: long utterances emit several is_final chunks with
        // speech_final still false, then a last Results whose transcript is
        // often only the tail. Concatenate before declaring the turn done
        // (ADR-126). Interims still pass through unchanged for barge-in.
        if (speechFinal) {
          const full = `${pendingFinalText} ${text}`.trim();
          pendingFinalText = "";
          if (!full) return;
          onTranscript({ text: full, isFinal: true, speechFinal: true, endpointSignal: "speech_final" });
          return;
        }

        if (!text) return;
        if (isFinal) {
          pendingFinalText = `${pendingFinalText} ${text}`.trim();
        }

        onTranscript({ text, isFinal, speechFinal: false });
      } catch (err) {
        console.error("[deepgram] failed to parse message", err);
      }
    });

    ws.addEventListener("error", (err) => console.error("[deepgram] socket error", err));

    ws.addEventListener("close", () => {
      isOpen = false;
      if (closedIntentionally) return;
      disconnectedAt = Date.now();
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error("[deepgram] gave up reconnecting after", reconnectAttempts, "attempts");
        onFatalError?.(new Error("Deepgram connection lost and reconnect attempts exhausted"));
        return;
      }
      reconnectAttempts += 1;
      stats.reconnectCount += 1;
      onStatsUpdate?.({ ...stats });
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1);
      console.warn(`[deepgram] connection closed unexpectedly — reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      reconnectTimer = setTimeout(open, delay);
    });
  }

  open();

  return {
    sendAudio(chunk: Uint8Array) {
      if (isOpen && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else {
        // Reconnecting — buffer instead of silently dropping the caller's audio.
        bufferAudio(chunk);
      }
    },
    getStats() {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      ws.close();
    },
  };
};
