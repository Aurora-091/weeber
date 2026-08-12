import type { ConnectTts } from "./types";
import { resolveVoiceId } from "./default-voices";

/**
 * Thin wrapper around Sarvam's streaming TTS WebSocket (Bulbul), for
 * natural Indian-language voices ElevenLabs/Cartesia don't cover.
 *
 * Configured to output mu-law 8kHz directly (`output_audio_codec: "mulaw"`)
 * — same zero-re-encoding path as the other two providers, no PCM
 * conversion needed on this side (unlike Sarvam's STT input, which needs
 * mu-law decoded — see stt/sarvam.ts and audio-codec.ts).
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

export const connectSarvamTts: ConnectTts = (onAudioChunk, onDone, onError, voiceIdOverride, languageOverride) => {
  const apiKey = process.env.SARVAM_API_KEY ?? "";
  const speaker = resolveVoiceId("sarvam", voiceIdOverride);
  const languageCode = toSarvamLanguageCode(languageOverride);
  const url = `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3&send_completion_event=true`;

  const ws = new WebSocket(url, { headers: { "Api-Subscription-Key": apiKey } } as unknown as string[]);

  let closedIntentionally = false;
  let finished = false;
  const pendingSends: string[] = [];

  function send(payload: Record<string, unknown>) {
    const json = JSON.stringify(payload);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      pendingSends.push(json);
    }
  }

  ws.addEventListener("open", () => {
    // Config must be the first message on the socket (Sarvam requirement).
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
      if (msg.type === "audio" && msg.data?.audio) onAudioChunk(msg.data.audio as string);
      if (msg.type === "event" && msg.data?.event_type === "final") {
        finished = true;
        onDone?.();
      }
      if (msg.type === "error") {
        console.error("[sarvam-tts] server error", msg.data ?? msg);
        onError?.(new Error(msg.data?.message ?? "Sarvam TTS error"));
      }
    } catch (err) {
      console.error("[sarvam-tts] failed to parse message", err);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[sarvam-tts] socket error", err);
    if (!finished && !closedIntentionally) onError?.(err);
  });

  ws.addEventListener("close", (evt) => {
    if (!finished && !closedIntentionally) {
      console.warn("[sarvam-tts] connection closed before turn finished", evt.code, evt.reason);
      onError?.(new Error(`Sarvam TTS socket closed unexpectedly (code ${evt.code})`));
    }
  });

  return {
    sendText(text: string) {
      send({ type: "text", data: { text } });
    },
    endTurn() {
      send({ type: "flush" });
    },
    close() {
      closedIntentionally = true;
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
};
