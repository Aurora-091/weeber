import type { ConnectStt, SttProvider } from "./types";
import { connectDeepgram } from "./deepgram";
import { connectSarvamStt } from "./sarvam";
import { connectElevenLabsStt } from "./elevenlabs";
import { prefersSarvam } from "../agent-frame";

/**
 * STT provider registry — mirrors tts/index.ts's pattern. Add a new
 * provider by dropping a file in this directory that implements
 * `ConnectStt` (see types.ts) and registering it here; stream.ts stays
 * provider-agnostic.
 */
const providers: Record<SttProvider, ConnectStt> = {
  deepgram: connectDeepgram,
  sarvam: connectSarvamStt,
  elevenlabs: connectElevenLabsStt,
};

/**
 * Which STT provider is active for a given call. Priority:
 *   1. explicit per-call/per-agent override (agent-frame.ts's `sttProvider`)
 *   2. smart Indic default (2026-07-19): when nothing above is set and the
 *      call's `language` is one Sarvam handles best (see prefersSarvam), route
 *      to Sarvam — India-specialized STT — instead of the English-first
 *      platform default that may fumble Indic speech. Guarded by SARVAM_API_KEY
 *      being present, so self-hosted setups without a Sarvam key fall through
 *      cleanly to the platform default below.
 *   3. STT_PROVIDER env var -> "deepgram" (unchanged default behavior).
 * Falls back with a warning on an unknown value.
 */
export function resolveSttProvider(override?: string | null, language?: string | null): SttProvider {
  // An explicit choice (per-agent/per-number/session, or a mid-call failover
  // target) always wins over the language-smart default.
  if (override) {
    const explicit = override.toLowerCase();
    if (explicit === "deepgram" || explicit === "sarvam" || explicit === "elevenlabs") return explicit;
    console.warn(`[stt] Unknown STT provider "${explicit}" — falling back to "deepgram"`);
    return "deepgram";
  }
  if (prefersSarvam(language) && process.env.SARVAM_API_KEY) return "sarvam";
  const configured = (process.env.STT_PROVIDER ?? "deepgram").toLowerCase();
  if (configured === "deepgram" || configured === "sarvam" || configured === "elevenlabs") return configured;
  console.warn(`[stt] Unknown STT provider "${configured}" — falling back to "deepgram"`);
  return "deepgram";
}

export function connectStt(
  onTranscript: Parameters<ConnectStt>[0],
  onFatalError?: Parameters<ConnectStt>[1],
  onStatsUpdate?: Parameters<ConnectStt>[2],
  onConnected?: Parameters<ConnectStt>[3],
  providerOverride?: string | null,
  language?: string,
) {
  const provider = resolveSttProvider(providerOverride, language);
  return providers[provider](onTranscript, onFatalError, onStatsUpdate, onConnected, language);
}

export type { ConnectStt, SttConnection, SttProvider, SttStats, SttTranscriptHandler } from "./types";
