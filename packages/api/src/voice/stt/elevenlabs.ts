import type { ConnectStt } from "./types";

/**
 * Thin wrapper around ElevenLabs' Scribe v2 Realtime streaming STT
 * WebSocket — see docs/hindi-hinglish-voice-support.md Phase 2 for the
 * research this is based on.
 *
 * LIVE-VERIFIED (2026-07-16, real API key, real Hinglish audio — see the
 * tracking doc for the full transcript): synthesized "मुझे एक flight book
 * करनी है, aur mera order भी confirm karna hai." via ElevenLabs TTS,
 * resampled to Twilio's exact 8kHz mu-law format, streamed through this
 * exact code path, and got back "मुझे एक flight book करनी है और मेरा order
 * भी confirm करना है।" — flight/book/order/confirm all stayed in Latin
 * script automatically, confirming the Indic-English code-switching claim
 * for real, not just from marketing copy.
 *
 * Two real bugs were found and fixed via that live test, replacing what was
 * originally a defensive, unverified guess:
 *   1. `audio_format`/`sample_rate` are CONNECTION-TIME query parameters,
 *      not per-message fields — the first version of this file put
 *      `sample_rate: 8000` inside each `input_audio_chunk` message, which
 *      the server silently ignored, defaulting the whole session to
 *      16kHz PCM regardless. Feeding 8kHz audio into a 16kHz-assumed
 *      session produced a corrupted waveform and nonsense transcripts
 *      (literally Korean-looking gibberish from the distorted audio) with
 *      no error of any kind — a real, silent-failure class of bug.
 *   2. `ulaw_8000` IS a valid `audio_format` (confirmed directly from the
 *      server's own error message enumerating valid values: `pcm_8000,
 *      pcm_16000, pcm_22050, pcm_24000, pcm_44100, pcm_48000, ulaw_8000`)
 *      — so Twilio's raw mu-law chunks can be sent completely unconverted,
 *      same zero-re-encoding path as the Deepgram/ElevenLabs/Cartesia TTS
 *      adapters. The original version defensively decoded to PCM16 first
 *      (extra CPU cost, and per-chunk `sample_rate` that turned out not to
 *      matter) because the mu-law option couldn't be confirmed from public
 *      docs alone — now confirmed, so that decode step is removed.
 *
 * Language: Scribe v2 Realtime's docs describe fully automatic language
 * detection and mid-conversation switching with "no language configuration
 * required" — so, unlike Deepgram/Sarvam, this adapter intentionally does
 * not send a language parameter at all (matches the live test above, which
 * used no language_code and still produced a clean code-switched result).
 * The `language` argument is accepted (for interface consistency with the
 * other providers) but currently unused.
 *
 * No reconnect loop (matches Sarvam's adapter, not Deepgram's) — an
 * unexpected close surfaces via onFatalError so the call ends cleanly
 * rather than hanging on dead audio. Add bounded auto-reconnect here if a
 * real call surfaces mid-call drops, same as Deepgram's adapter already
 * does.
 */
export const connectElevenLabsStt: ConnectStt = (onTranscript, onFatalError, _onStatsUpdate, onConnected) => {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const url =
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
    "?model_id=scribe_v2_realtime&sample_rate=8000&audio_format=ulaw_8000";

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
      // Sent completely unconverted — ulaw_8000 is a confirmed-valid
      // audio_format for this connection (see doc comment above), so
      // Twilio's mu-law bytes go straight over the wire, same
      // zero-re-encoding path the TTS adapters already use.
      const audioBase64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: audioBase64, commit: false }));
    },
    getStats() {
      return { ...stats };
    },
    close() {
      closedIntentionally = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true }));
        // Live-test bug found and fixed (2026-07-16, see doc comment above):
        // closing the socket immediately after sending commit:true raced
        // the server's response — the final utterance's committed_transcript
        // was lost every time (confirmed directly: the exact same
        // send-commit-then-immediately-close sequence produced nothing,
        // while leaving the socket open after the identical commit message
        // reliably produced a committed_transcript ~1-2s later). A bounded
        // grace period, not a real ack/response wait, matches the same
        // "give the in-flight thing a beat before hard-closing"
        // pattern stream.ts's own hangUp/transfer handling already uses.
        setTimeout(() => ws.close(), 1500);
      }
    },
  };
};
