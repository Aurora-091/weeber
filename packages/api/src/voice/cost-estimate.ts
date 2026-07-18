/**
 * Per-call cost estimate (2026-07-18, India feature-gap analysis Phase 3 —
 * "per-call cost visibility in merchant dashboard"). Indian SMBs are
 * brutally price-sensitive and a monthly invoice with no per-call breakdown
 * makes cost feel unpredictable, which is a real retention risk — this
 * gives every call row a rough "~$X" figure the moment it ends.
 *
 * Deliberately an ESTIMATE, not a reconciled bill:
 * - Per-minute rates below are sourced from each provider's public pricing
 *   pages (telephony) or this codebase's own existing agent-config cost-tier
 *   notes (STT/TTS — see packages/web/src/web/lib/agent-config.ts's
 *   TTS_COST_TIERS/STT_COST_TIERS, kept in sync with those by hand since
 *   packages/web and packages/api don't share a common package today).
 * - LLM cost is a single flat per-minute approximation, not derived from
 *   real token counts — actual per-call token usage isn't tracked anywhere
 *   in the live call path today (only estimateLlmCost in voice/llm/index.ts,
 *   used solely by the text-only test-chat preview endpoint). Revisit once
 *   real per-call token counts are captured; until then this is a rough
 *   blended figure for a typical conversational exchange rate, not a
 *   provider-specific lookup.
 * - Real invoiced rates vary by plan, volume, and negotiated pricing — this
 *   number exists to give a merchant a directional sense of what a call
 *   cost, not to replace their actual bill from us or from any provider.
 */

export type TelephonyProviderForCost = "twilio" | "plivo" | "exotel";
export type SttProviderForCost = "deepgram" | "sarvam" | "elevenlabs";
export type TtsProviderForCost = "cartesia" | "elevenlabs" | "sarvam";

/** USD per minute, outbound to an Indian mobile number — sourced from each
 * provider's public pricing page (2026-07-18): Twilio ~$0.0075/min (India
 * outbound-to-mobile), Plivo ~$0.0115/min (local/mobile), Exotel ~₹0.80-1.50
 * (national outbound) taken at a rough ₹85/USD rate ≈ $0.010-0.018, midpoint
 * used. All three are marked "estimated" for the same reason the existing
 * STT/TTS tier notes are — public list price, not this platform's actual
 * negotiated rate. */
const TELEPHONY_RATE_PER_MIN_USD: Record<TelephonyProviderForCost, number> = {
  twilio: 0.0075,
  plivo: 0.0115,
  exotel: 0.014,
};

/** Mirrors packages/web/src/web/lib/agent-config.ts's STT_COST_TIERS notes —
 * keep these two in sync by hand if either changes. */
const STT_RATE_PER_MIN_USD: Record<SttProviderForCost, number> = {
  deepgram: 0.005,
  sarvam: 0.006,
  elevenlabs: 0.0055,
};

/** Mirrors packages/web/src/web/lib/agent-config.ts's TTS_COST_TIERS notes —
 * keep these two in sync by hand if either changes. Midpoints used for the
 * two providers quoted as a range there. */
const TTS_RATE_PER_MIN_USD: Record<TtsProviderForCost, number> = {
  cartesia: 0.03,
  sarvam: 0.003,
  elevenlabs: 0.11,
};

/** Flat blended estimate for the LLM leg — see the module doc comment for
 * why this isn't token-derived yet. Roughly in line with a typical
 * gpt-4o-mini/Groq-class model at conversational turn-taking cadence. */
const LLM_FLAT_RATE_PER_MIN_USD_ESTIMATE = 0.006;

function isTelephonyProviderForCost(v: string | null | undefined): v is TelephonyProviderForCost {
  return v === "twilio" || v === "plivo" || v === "exotel";
}
function isSttProviderForCost(v: string | null | undefined): v is SttProviderForCost {
  return v === "deepgram" || v === "sarvam" || v === "elevenlabs";
}
function isTtsProviderForCost(v: string | null | undefined): v is TtsProviderForCost {
  return v === "cartesia" || v === "sarvam" || v === "elevenlabs";
}

export type EstimateCallCostInput = {
  telephonyProvider?: string | null;
  sttProvider?: string | null;
  ttsProvider?: string | null;
  durationSeconds: number;
};

/**
 * Returns an estimated cost in US cents (a float, e.g. 12.34 = ~$0.1234), or
 * null when there isn't enough to go on (no duration, or an unrecognized
 * telephony provider — telephony is the one leg every real call has, so if
 * that can't be priced the whole estimate is meaningless rather than
 * partially wrong). STT/TTS legs are optional-and-skipped (not nulled out
 * entirely) when unrecognized, since a call can genuinely have no STT/TTS
 * resolved yet (e.g. it failed before either connected) — LLM is always
 * included since every answered call reaches the LLM at least once (the
 * greeting).
 */
export function estimateCallCostCents(input: EstimateCallCostInput): number | null {
  const { telephonyProvider, sttProvider, ttsProvider, durationSeconds } = input;
  if (!durationSeconds || durationSeconds <= 0) return null;
  if (!isTelephonyProviderForCost(telephonyProvider)) return null;

  const minutes = durationSeconds / 60;
  let usd = TELEPHONY_RATE_PER_MIN_USD[telephonyProvider] * minutes;
  usd += LLM_FLAT_RATE_PER_MIN_USD_ESTIMATE * minutes;
  if (isSttProviderForCost(sttProvider)) {
    usd += STT_RATE_PER_MIN_USD[sttProvider] * minutes;
  }
  if (isTtsProviderForCost(ttsProvider)) {
    usd += TTS_RATE_PER_MIN_USD[ttsProvider] * minutes;
  }
  return Math.round(usd * 100 * 100) / 100; // cents, rounded to 2 decimal places
}
