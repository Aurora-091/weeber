/**
 * Five Bets Phase IV — backchannels (Bet 2 remainder).
 *
 * Pre-tool fillers (agent.ts TOOL_CALL_FILLER_THRESHOLD_MS + stream.ts
 * maybePlayToolCallFiller) already cover the *agent-is-working* window — the
 * caller hears "one moment" instead of dead air while a slow tool finishes.
 * Nothing covers the *caller-is-talking* window: the agent is silent while
 * the caller speaks a long sentence, which reads as "is it still there?" to
 * older callers. Backchannels are short, low-latency acknowledgments
 * ("mm-hm", "right", "okay") played *sparingly* while the caller is
 * mid-utterance, on partial (interim) STT results.
 *
 * This module is the PURE decision + the line/flag constants only. All
 * stateful plumbing (interim-STT hook, utterance timer, cached-clip player,
 * warm cache) lives in stream.ts, same split as every other audio feature.
 *
 * Design guardrails baked into `shouldBackchannel`:
 *  - Off by default — org feature flag (BACKCHANNEL_FLAG), enable for
 *    final-expense / elderly personas first, same kill-switch pattern as
 *    EXPRESSIVE_DELIVERY_FLAG / ADAPTIVE_NOISE_FILTER_FLAG.
 *  - NEVER during the agent's own turn (would talk over the agent).
 *  - NEVER on speech_final — that's a real end-of-turn, not a mid-utterance
 *    moment; the turn handler owns it.
 *  - Only after the caller has been talking past BACKCHANNEL_MIN_UTTERANCE_MS
 *    (don't ack a two-word answer; let them actually get rolling).
 *  - Hard rate-limited to at most one per BACKCHANNEL_MIN_GAP_MS (a
 *    chatterbox agent is worse than a silent one).
 *
 * Backchannels are deliberately NOT a turn: they never enter `history` or
 * the transcript, never set agentIsSpeaking, and never abort/clear — so they
 * cannot corrupt turn-taking, barge-in, or endsMidThought.
 */

/** Opt-in org/global feature flag — see org-queries.ts getEffectiveFlags. */
export const BACKCHANNEL_FLAG = "backchannels";

/**
 * The caller must have been talking at least this long (this utterance)
 * before the first backchannel — a short answer ("yes", "ORD-48213") should
 * never be interrupted by an "mm-hm".
 */
export const BACKCHANNEL_MIN_UTTERANCE_MS = 2500;

/** At most one backchannel per this window — hard cap against over-acking. */
export const BACKCHANNEL_MIN_GAP_MS = 4000;

/**
 * Short, low-latency acknowledgment clips. Kept tiny and generic so they're
 * cheap to warm-cache and never carry content that could be wrong. Warmed on
 * call start (stream.ts) exactly like the tool-call fillers, and only ever
 * played from cache — synthesizing live would add the very latency a
 * backchannel exists to avoid.
 */
export const BACKCHANNEL_LINES = ["Mm-hm.", "Right.", "Okay."];

export type BackchannelDecisionInput = {
  /** Org feature flag resolved once per call. */
  enabled: boolean;
  /** True while the agent's own TTS is playing — never backchannel over it. */
  agentIsSpeaking: boolean;
  /** Deepgram speech_final — the end-of-turn endpoint, owned by the turn handler. */
  speechFinal: boolean;
  /** The interim transcript has non-empty text (the caller is actually saying something). */
  hasText: boolean;
  /** How long the caller has been talking this utterance, in ms. */
  utteranceMs: number;
  /** ms since the last backchannel this call, or null if none yet. */
  msSinceLastBackchannel: number | null;
};

/**
 * Pure, deterministic: given the current mid-utterance state, may we play a
 * single backchannel right now? All the guardrails above, in one place, so
 * they're unit-testable without the audio path.
 */
export function shouldBackchannel(i: BackchannelDecisionInput): boolean {
  if (!i.enabled) return false;
  if (i.agentIsSpeaking) return false;
  if (i.speechFinal) return false;
  if (!i.hasText) return false;
  if (i.utteranceMs < BACKCHANNEL_MIN_UTTERANCE_MS) return false;
  if (i.msSinceLastBackchannel !== null && i.msSinceLastBackchannel < BACKCHANNEL_MIN_GAP_MS) return false;
  return true;
}
