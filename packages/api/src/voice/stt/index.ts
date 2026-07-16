import type { ConnectStt, SttProvider } from "./types";
import { connectDeepgram } from "./deepgram";
import { connectSarvamStt } from "./sarvam";
import { connectElevenLabsStt } from "./elevenlabs";

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
 * Which STT provider is active for a given call. Priority: explicit
 * per-call/per-agent override (from agent-frame.ts's `sttProvider`) -> the
 * STT_PROVIDER env var -> "deepgram" (unchanged default behavior for every
 * existing deployment). Falls back with a warning on an unknown value.
 */
export function resolveSttProvider(override?: string | null): SttProvider {
  const configured = (override ?? process.env.STT_PROVIDER ?? "deepgram").toLowerCase();
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
  const provider = resolveSttProvider(providerOverride);
  return providers[provider](onTranscript, onFatalError, onStatsUpdate, onConnected, language);
}

export type { ConnectStt, SttConnection, SttProvider, SttStats, SttTranscriptHandler } from "./types";
