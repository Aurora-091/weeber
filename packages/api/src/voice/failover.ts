import type { SttProvider } from "./stt/types";
import type { TtsProvider } from "./tts/types";

/**
 * Cross-provider failover (2026-07-17, recommendation #1 of
 * docs/product-infra-and-gtm-report.md Part 4). The provider-abstraction
 * layer (stt/index.ts, tts/index.ts) already lets every call pick one
 * provider per type; this module is the small addition on top that decides
 * what to try *next* if that one provider hard-fails mid-call, instead of
 * just ending the call. stream.ts is the only caller — it owns the actual
 * reconnect/retry logic, this module is pure "given a primary and an
 * optional per-agent override, what's the ordered list of providers to try
 * next" so that policy lives in one place and is unit-testable in
 * isolation from the call-handling code.
 *
 * Platform-default chains, chosen from what's already wired up (all three
 * STT and all three TTS providers are already live options today — this
 * doesn't add a new provider integration, just an order to fail over
 * through): the two most broadly-proven/general-purpose providers first
 * (Deepgram/Cartesia are each this platform's own default primary — see
 * stt/index.ts's and tts/index.ts's resolveXProvider — so they're also the
 * strongest fallback candidates), ElevenLabs next (also fully wired for
 * both STT and TTS here, comparable quality tier), Sarvam last (the
 * India/regional-language specialist — a good *primary* choice for Indian-
 * language calls, but the narrowest fit as a blind fallback for a call
 * that started on a different provider for language reasons).
 */
export const DEFAULT_STT_FALLBACK_ORDER: SttProvider[] = ["deepgram", "elevenlabs", "sarvam"];
// `fish` (2026-08-25) is deliberately NOT in the default chain — it's an
// unverified-against-a-live-account adapter (see tts/fish.ts's doc comment);
// failing an existing call over to it automatically would be a worse outage
// than just ending the call. Valid only via an explicit per-agent
// `ttsFallbackOrder` override until it's had a real call.
export const DEFAULT_TTS_FALLBACK_ORDER: TtsProvider[] = ["cartesia", "elevenlabs", "sarvam"];

const STT_PROVIDERS = new Set<SttProvider>(["deepgram", "sarvam", "elevenlabs"]);
const TTS_PROVIDERS = new Set<TtsProvider>(["elevenlabs", "cartesia", "sarvam", "fish"]);

/**
 * Builds the ordered list of STT providers to try after `primary` fails.
 * `override` is the per-agent `sttFallbackOrder` column (org_agent_configs)
 * — when present, it's used verbatim (minus the primary and any invalid
 * values) instead of the platform default, so an agent can be pinned to a
 * specific chain (e.g. an insurance agent that should never fail over to a
 * provider whose data-handling terms haven't been reviewed). Falls open to
 * the platform default whenever override is null/undefined/empty — never
 * throws on garbage input, same fail-open philosophy as the rest of the
 * per-agent config surface (resolveSttProvider et al.).
 */
export function resolveSttFailoverChain(primary: SttProvider, override?: readonly string[] | null): SttProvider[] {
  const source = override && override.length > 0 ? override : DEFAULT_STT_FALLBACK_ORDER;
  const seen = new Set<SttProvider>([primary]);
  const chain: SttProvider[] = [];
  for (const candidate of source) {
    if (!STT_PROVIDERS.has(candidate as SttProvider)) continue;
    const p = candidate as SttProvider;
    if (seen.has(p)) continue;
    seen.add(p);
    chain.push(p);
  }
  return chain;
}

/** Same as resolveSttFailoverChain, for TTS. */
export function resolveTtsFailoverChain(primary: TtsProvider, override?: readonly string[] | null): TtsProvider[] {
  const source = override && override.length > 0 ? override : DEFAULT_TTS_FALLBACK_ORDER;
  const seen = new Set<TtsProvider>([primary]);
  const chain: TtsProvider[] = [];
  for (const candidate of source) {
    if (!TTS_PROVIDERS.has(candidate as TtsProvider)) continue;
    const p = candidate as TtsProvider;
    if (seen.has(p)) continue;
    seen.add(p);
    chain.push(p);
  }
  return chain;
}
