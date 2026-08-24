import type { TtsProvider } from "./types";

/**
 * The per-provider fallback voice, as a code constant rather than an env var.
 *
 * A voice is an *agent* property, not a *deployment* property. Which person
 * the caller hears is chosen per agent in the dashboard's voice picker
 * (`voices-catalog.ts` → `org_agent_configs.voice_provider` + `voice_id`) and
 * is threaded down to the adapters as `voiceIdOverride`. Reading a
 * `<PROVIDER>_VOICE_ID` env var underneath that made the same agent row speak
 * with a different voice depending on which deployment served the call, which
 * is exactly the "the agent became a different person" hazard ADR-070 and
 * `tts-voice-identity.ts` exist to prevent — reintroduced one layer lower.
 *
 * It also failed silently. `ELEVENLABS_VOICE_ID` was never set in production,
 * so every path that reached the ElevenLabs adapter without a per-agent
 * ElevenLabs voice built `wss://api.elevenlabs.io/v1/text-to-speech/undefined/
 * stream-input` — the declared cross-provider failover leg could not have
 * worked, and nothing said so at boot or on the call record. That is the
 * failure mode a constant cannot have: it is either present in this file or
 * the build does not typecheck.
 *
 * These are deliberately *fallbacks*, not defaults to be relied on. They are
 * reached when an agent row has no voice for the provider being connected to —
 * either because it was never configured, or because `voiceIdForProvider`
 * withheld a foreign ID during failover (a Cartesia UUID is meaningless to
 * ElevenLabs). Every entry is a public, no-extra-cost voice on that provider,
 * verified to resolve against the live API on 2026-08-12, and all three are
 * feminine English-first conversational voices so a failover mid-call is heard
 * as "a slightly different person" rather than a jarring change of sex or
 * accent.
 */
export const FALLBACK_VOICE_BY_PROVIDER: Record<TtsProvider, string> = {
  /** "Katie - Friendly Fixer" (en, feminine) — "Enunciating young adult female
   * for conversational support use cases". Was `CARTESIA_VOICE_ID` in Railway
   * production, so pinning it here keeps every existing agent on the exact
   * voice its callers already heard. */
  cartesia: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
  /** "Sarah - Mature, Reassuring, Confident" (american, premade) — a stock
   * library voice available on every ElevenLabs tier including free, so this
   * leg does not depend on plan level the way a cloned voice would. */
  elevenlabs: "EXAVITQu4vr4xnSDxMaL",
  /** `bulbul:v3`'s own default speaker. Sarvam takes a fixed speaker *name*,
   * not an ID, and has no list-voices API (see voices-catalog.ts). */
  sarvam: "shubh",
  /** Unverified (2026-08-25) — no live Fish Audio account in this sandbox to confirm a real
   * `reference_id` against. Empty string, not a guessed UUID: `resolveVoiceId` treats a blank/
   * whitespace-only value as "not configured" and every call site here omits an empty `reference_id`
   * from the request rather than sending one, which per Fish's docs falls back to the selected model's
   * own built-in default voice. See tts/fish.ts's doc comment. */
  fish: "",
};

/**
 * The voice ID to actually send to `provider` for this turn: the agent's own
 * configured voice when it has one, otherwise that provider's fallback above.
 *
 * Blank-safe on purpose — an empty or whitespace-only `voiceId` reaching an
 * adapter used to be interpolated straight into a request as an empty path
 * segment or an empty `voice.id`, which each provider rejects differently and
 * none of them reject usefully. Treating it as "not configured" is the only
 * behaviour that produces audio.
 */
export function resolveVoiceId(provider: TtsProvider, voiceId?: string): string {
  const configured = voiceId?.trim();
  return configured || FALLBACK_VOICE_BY_PROVIDER[provider];
}
