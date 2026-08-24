import type { ConnectTts, ConnectTtsSession, TtsProvider } from "./types";
import { connectElevenLabsTts, connectElevenLabsSession } from "./elevenlabs";
import { connectCartesiaTts, connectCartesiaSession } from "./cartesia";
import { connectSarvamTts, connectSarvamSession } from "./sarvam";
import { connectFishTts, connectFishSession } from "./fish";
import { prefersSarvam } from "../agent-frame";

/**
 * TTS provider registry. Add a new provider by dropping a file in this
 * directory that implements `ConnectTts` (see types.ts) and registering it
 * here — the rest of the pipeline (stream.ts) is provider-agnostic.
 */
const providers: Record<TtsProvider, ConnectTts> = {
  elevenlabs: connectElevenLabsTts,
  cartesia: connectCartesiaTts,
  sarvam: connectSarvamTts,
  fish: connectFishTts,
};

/** Session-factory registry, one persistent-connection opener per provider
 * (Phase C1) — see connectTtsSession below. `fish` doesn't actually get a
 * persistent connection (see tts/fish.ts's doc comment) but implements the
 * same interface. */
const sessionProviders: Record<TtsProvider, ConnectTtsSession> = {
  elevenlabs: connectElevenLabsSession,
  cartesia: connectCartesiaSession,
  sarvam: connectSarvamSession,
  fish: connectFishSession,
};

/**
 * Which TTS provider is active for a given call. Priority:
 *   1. explicit per-call/per-agent override (agent-frame.ts's `voiceProvider`)
 *   2. smart Indic default (2026-07-19): when nothing above is set and the
 *      call's `language` is one Sarvam voices Indic best (see prefersSarvam),
 *      route to Sarvam instead of the English-first Cartesia default so Indic
 *      calls get a natural Indic voice. Guarded by SARVAM_API_KEY, so setups
 *      without a Sarvam key fall through cleanly to the default below.
 *   3. TTS_PROVIDER env var -> "cartesia" (works on free/starter tiers without
 *      the library-voice restriction ElevenLabs' free plan has).
 * Falls back with a warning if an unknown value is set.
 *
 * `fish` (2026-08-25) is reachable only via an explicit override (step 1) or
 * `TTS_PROVIDER=fish` (step 3) — deliberately never a smart/env default, the
 * same caution ADR-119/Phase E-style "explicit, not inferred" pattern this
 * codebase uses elsewhere, because this adapter is unverified against a live
 * account (see tts/fish.ts's doc comment). An org has to ask for it by name.
 */
export function resolveTtsProvider(override?: string | null, language?: string | null): TtsProvider {
  if (override) {
    const explicit = override.toLowerCase();
    if (explicit === "elevenlabs" || explicit === "cartesia" || explicit === "sarvam" || explicit === "fish") return explicit;
    console.warn(`[tts] Unknown TTS provider "${explicit}" — falling back to "cartesia"`);
    return "cartesia";
  }
  if (prefersSarvam(language) && process.env.SARVAM_API_KEY) return "sarvam";
  const configured = (process.env.TTS_PROVIDER ?? "cartesia").toLowerCase();
  if (configured === "elevenlabs" || configured === "cartesia" || configured === "sarvam" || configured === "fish") return configured;
  console.warn(`[tts] Unknown TTS provider "${configured}" — falling back to "cartesia"`);
  return "cartesia";
}

export function connectTts(
  onAudioChunk: (base64Audio: string) => void,
  onDone?: () => void,
  onError?: (err: unknown) => void,
  providerOverride?: string | null,
  voiceIdOverride?: string,
  languageOverride?: string,
  onWordTimestamp?: (word: string, startMs: number, endMs: number) => void,
  onConnected?: (ms: number) => void,
) {
  const provider = resolveTtsProvider(providerOverride, languageOverride);
  return providers[provider](
    onAudioChunk,
    onDone,
    onError,
    voiceIdOverride,
    languageOverride,
    onWordTimestamp,
    onConnected,
  );
}

/**
 * Opens a persistent, multi-turn TTS connection for one (provider, voice,
 * language) combination (Phase C1). Same resolution rules as connectTts —
 * this is the session-level counterpart stream.ts holds for the life of a
 * call instead of reconnecting every turn.
 */
export function connectTtsSession(
  providerOverride?: string | null,
  voiceIdOverride?: string,
  languageOverride?: string,
  onConnected?: (ms: number) => void,
) {
  const provider = resolveTtsProvider(providerOverride, languageOverride);
  return { provider, session: sessionProviders[provider](voiceIdOverride, languageOverride, onConnected) };
}

export type { ConnectTts, TtsConnection, TtsProvider, TtsSession } from "./types";
