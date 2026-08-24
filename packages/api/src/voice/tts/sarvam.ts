import type { ConnectTts, ConnectTtsSession, TtsSession } from "./types";
import { resolveVoiceId } from "./default-voices";

/**
 * Thin wrapper around Sarvam's streaming TTS WebSocket (Bulbul), for
 * natural Indian-language voices ElevenLabs/Cartesia don't cover.
 *
 * Configured to output mu-law 8kHz directly (`output_audio_codec: "mulaw"`)
 * — same zero-re-encoding path as the other two providers, no PCM
 * conversion needed on this side (unlike Sarvam's STT input, which needs
 * mu-law decoded — see stt/sarvam.ts and audio-codec.ts).
 *
 * Phase C1 (2026-08-24): Sarvam's own docs describe exactly this reuse —
 * "Persistent Connection: Single WebSocket connection handles multiple text
 * to speech conversions. Send config once, then stream text continuously"
 * — with one documented exception: on a caller barge-in, close and reopen
 * rather than trying to cancel mid-utterance. `connectSarvamSession` sends
 * `config` once; `startTurn` is just a `text`/`flush` cycle, and `close()`
 * (used for both barge-in and call-end) tears down the whole socket, which
 * is Sarvam's own recommendation for the former and simply correct for the
 * latter. Unlike Cartesia/ElevenLabs there's no per-turn context id in
 * Sarvam's protocol — messages between one `flush` and the next belong to
 * "the current turn" by construction, which holds because stream.ts never
 * starts a turn before the previous one's `onDone` (the "final" event) has
 * fired.
 */
const SAMPLE_RATE = 8000;
// The default speaker moved to default-voices.ts's FALLBACK_VOICE_BY_PROVIDER
// so all three providers' fallback voices are declared in one place.
const DEFAULT_LANGUAGE_CODE = "hi-IN";

/** ISO-ish agent-frame language code -> Sarvam's BCP-47 target_language_code. */
export function toSarvamLanguageCode(language?: string): string {
  if (!language || language === "multi" || language === "unknown") return DEFAULT_LANGUAGE_CODE;
  if (language.includes("-")) return language;
  if (language === "en") return "en-IN";
  // Hinglish (Hindi-English code-mix) has no dedicated Sarvam code — the Hindi
  // voice (hi-IN) renders the code-mixed text naturally, so map it there.
  if (language === "hinglish") return "hi-IN";
  return `${language}-IN`;
}

export const connectSarvamSession: ConnectTtsSession = (voiceIdOverride, languageOverride, onConnected) => {
  const connectRequestedAt = Date.now();
  const apiKey = process.env.SARVAM_API_KEY ?? "";
  const speaker = resolveVoiceId("sarvam", voiceIdOverride);
  const languageCode = toSarvamLanguageCode(languageOverride);
  const url = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`;

  const ws = new WebSocket(url, { headers: { "Api-Subscription-Key": apiKey } } as unknown as string[]);

  let closedIntentionally = false;
  let connectedFired = false;
  const pendingSends: string[] = [];

  let current:
    | {
        onAudioChunk: (base64Audio: string) => void;
        onDone?: () => void;
        onError?: (err: unknown) => void;
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
    if (!connectedFired) {
      connectedFired = true;
      onConnected?.(Date.now() - connectRequestedAt);
    }
    // Config must be the first message on the socket (Sarvam requirement) —
    // sent exactly once per connection, not per turn.
    send({
      type: "config",
      data: {
        model: "bulbul:v3",
        target_language_code: languageCode,
        speaker,
        speech_sample_rate: String(SAMPLE_RATE),
        output_audio_codec: "mulaw",
      },
    });
    for (const json of pendingSends.splice(0)) ws.send(json);
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string);
      const turn = current;
      if (msg.type === "audio" && msg.data?.audio) turn?.onAudioChunk(msg.data.audio as string);
      if (msg.type === "event" && msg.data?.event_type === "final") {
        if (turn) {
          turn.finished = true;
          turn.onDone?.();
        }
      }
      if (msg.type === "error") {
        console.error("[sarvam-tts] server error", msg.data ?? msg);
        turn?.onError?.(new Error(msg.data?.message ?? "Sarvam TTS error"));
      }
    } catch (err) {
      console.error("[sarvam-tts] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[sarvam-tts] socket error", err);
    if (current && !current.finished && !closedIntentionally) current.onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (current && !current.finished && !closedIntentionally) {
      console.warn("[sarvam-tts] connection closed before turn finished", evt.code, evt.reason);
      current.onError?.(new Error(`Sarvam TTS socket closed unexpectedly (code ${evt.code})`));
    }
  });

  const session: TtsSession = {
    startTurn(onAudioChunk, onDone, onError) {
      current = { onAudioChunk, onDone, onError, finished: false };
      return {
        sendText(text: string) {
          send({ type: "text", data: { text } });
        },
        endTurn() {
          send({ type: "flush" });
        },
        close() {
          // Sarvam's own docs: on a caller barge-in, close and reopen rather
          // than cancel mid-utterance.
          closedIntentionally = true;
          if (ws.readyState === WebSocket.OPEN) ws.close();
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
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
  return session;
};

export const connectSarvamTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, languageOverride, _onWordTimestamp, onConnected) => {
  const session = connectSarvamSession(voiceIdOverride, languageOverride, onConnected);
  const turn = session.startTurn(onAudioChunk, onDone, onError);
  return {
    ...turn,
    close() {
      turn.close();
      session.close();
    },
  };
};
