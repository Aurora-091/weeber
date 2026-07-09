import type { ConnectTts, TtsProvider } from "./types";
import { connectElevenLabsTts } from "./elevenlabs";
import { connectCartesiaTts } from "./cartesia";

/**
 * TTS provider registry. Add a new provider by dropping a file in this
 * directory that implements `ConnectTts` (see types.ts) and registering it
 * here — the rest of the pipeline (stream.ts) is provider-agnostic.
 */
const providers: Record<TtsProvider, ConnectTts> = {
  elevenlabs: connectElevenLabsTts,
  cartesia: connectCartesiaTts,
};

/**
 * Which provider is active, configured via the TTS_PROVIDER env var.
 * Defaults to "cartesia" since it works on free/starter tiers without the
 * library-voice restriction ElevenLabs' free plan has. Falls back with a
 * warning if an unknown value is set.
 */
export function resolveTtsProvider(override?: TtsProvider): TtsProvider {
  const configured = (override ?? process.env.TTS_PROVIDER ?? "cartesia").toLowerCase();
  if (configured === "elevenlabs" || configured === "cartesia") return configured;
  console.warn(`[tts] Unknown TTS provider "${configured}" — falling back to "cartesia"`);
  return "cartesia";
}

export function connectTts(
  onAudioChunk: (base64Audio: string) => void,
  onDone?: () => void,
  onError?: (err: unknown) => void,
  providerOverride?: TtsProvider,
) {
  const provider = resolveTtsProvider(providerOverride);
  return providers[provider](onAudioChunk, onDone, onError);
}

export type { ConnectTts, TtsConnection, TtsProvider } from "./types";
