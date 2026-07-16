import type { ConnectStt } from "./types";
import { mulawToPcm16 } from "../audio-codec";

/**
 * Thin wrapper around ElevenLabs' Scribe v2 Realtime streaming STT
 * WebSocket — see docs/hindi-hinglish-voice-support.md Phase 2 for the
 * research this is based on.
 *
 * IMPORTANT — verify before treating this as production-reliable:
 *
 * 1. Audio format: ElevenLabs' own realtime-speech-to-text landing page
 *    states the API "supports PCM (8-48kHz) and mu-law encoding", but every
 *    worked example in their public docs (server-side-streaming guide) only
 *    shows raw 16-bit PCM chunks sent as `{"message_type":
 *    "input_audio_chunk", "audio_base_64": ..., "sample_rate": N}` — no
 *    documented `audio_format`/encoding literal for mu-law was found in the
 *    public WebSocket reference (only their SDK-level `AudioFormat.PCM_16000`
 *    enum appeared, no `ULAW_8000` equivalent could be confirmed). Rather
 *    than guess an unconfirmed mu-law mode, this adapter decodes Twilio's
 *    8kHz mu-law to 16-bit PCM first (mulawToPcm16, already used for
 *    Sarvam's STT for the same reason) and sends that as
 *    `sample_rate: 8000` raw PCM — the one path actually shown working in
 *    ElevenLabs' own examples. Costs a small CPU decode step per chunk
 *    (same cost Sarvam's adapter already pays), not a network/latency cost.
 * 2. Language: Scribe v2 Realtime's docs describe fully automatic language
 *    detection and mid-conversation switching with "no language
 *    configuration required" — so, unlike Deepgram/Sarvam, this adapter
 *    intentionally does not send a language parameter at all. The `language`
 *    argument is accepted (for interface consistency with the other
 *    providers) but currently unused.
 * 3. The specific "Indic-English code-switching" quality claim (English
 *    words stay in Latin script automatically) was published for "Scribe
 *    v2" — this needs a real test call to confirm it holds identically for
 *    "Scribe v2 Realtime" (the streaming model this adapter actually uses)
 *    before defaulting any org's Hindi/Hinglish agent onto this provider.
 *
 * No reconnect loop (matches Sarvam's adapter, not Deepgram's) — an
 * unexpected close surfaces via onFatalError so the call ends cleanly
 * rather than hanging on dead audio. Add bounded auto-reconnect here if a
 * real call surfaces mid-call drops, same as Deepgram's adapter already
 * does.
 */
const SAMPLE_RATE = 8000;

export const connectElevenLabsStt: ConnectStt = (onTranscript, onFatalError, _onStatsUpdate, onConnected) => {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const url = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime";

  const stats = { reconnectCount: 0, totalGapMs: 0 };
  const connectRequestedAt = Date.now();
  let hasReportedInitialConnect = false;
  let isOpen = false;
  let closedIntentionally = false;

  // Bun's WebSocket constructor accepts headers directly (server-side-only
  // extension, same pattern already used in stt/sarvam.ts for its
  // Api-Subscription-Key header) — ElevenLabs authenticates via `xi-api-key`.
  const ws = new WebSocket(url, {
    headers: { "xi-api-key": apiKey },
  } as unknown as string[]);

  ws.addEventListener("open", () => {
    isOpen = true;
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      switch (msg.message_type) {
        case "session_started":
          // The one signal this connection is actually ready — report
          // connect latency here rather than on the raw socket "open"
          // event, matching Deepgram/Sarvam's onConnected semantics (first
          // moment the provider itself confirms it's ready, not just TCP/TLS
          // handshake complete).
          if (!hasReportedInitialConnect) {
            hasReportedInitialConnect = true;
            onConnected?.(Date.now() - connectRequestedAt);
          }
          break;
        case "partial_transcript":
          if (msg.text) onTranscript({ text: String(msg.text), isFinal: false, speechFinal: false });
          break;
        case "committed_transcript":
          // Scribe v2 Realtime's VAD commits an utterance as a single unit
          // (no separate is_final vs speech_final distinction like
          // Deepgram) — treat every committed transcript as final, same
          // convention stt/sarvam.ts already uses for its one-message-per-
          // utterance shape.
          if (msg.text) onTranscript({ text: String(msg.text), isFinal: true, speechFinal: true });
          break;
        case "input_error":
          console.error("[elevenlabs-stt] input error", msg);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error("[elevenlabs-stt] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[elevenlabs-stt] socket error", err);
    if (!closedIntentionally) onFatalError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    isOpen = false;
    if (!closedIntentionally) {
      console.warn("[elevenlabs-stt] connection closed unexpectedly", evt.code, evt.reason);
      onFatalError?.(new Error(`ElevenLabs STT socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendAudio(chunk: Uint8Array) {
      if (!isOpen || ws.readyState !== WebSocket.OPEN) return;
      const pcm16 = mulawToPcm16(chunk);
      const audioBase64 = Buffer.from(pcm16).toString("base64");
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: audioBase64, commit: false, sample_rate: SAMPLE_RATE }));
    },
    getStats() {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: SAMPLE_RATE }));
        ws.close();
      }
    },
  };
};
