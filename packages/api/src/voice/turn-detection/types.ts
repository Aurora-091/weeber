/**
 * Five Bets Phase V — semantic turn-detection (Bet 1).
 *
 * The pluggable end-of-turn (EOT) *seam*. Today the live call decides "did
 * the caller finish talking?" from Deepgram `speech_final` (a fixed silence
 * timeout) refined by the `endsMidThought` regex. That works but silence
 * alone either cuts callers off mid-thought or waits too long. A learned EOT
 * model would decide from semantics — but per the build plan's gate, we do
 * NOT wire a model until Phase II health data proves calls are actually
 * getting cut off, and not while staging+prod share a database.
 *
 * So Phase V ships the *interface + fallback discipline*, not a vendor: a
 * `TurnEndDetector` any adapter (heuristic today; Smart Turn / OpenAI
 * Realtime / LiveKit later) can implement, a latency-budget guard so a slow
 * model degrades to today's behavior instead of stalling the hottest line in
 * the product, and a composite that only spends a model call where it can
 * prevent a cut-off. Dropping in a real model later is a one-line config
 * change, made blind to no vendor.
 */

export type TurnEndInput = {
  /** The caller's transcript for the current utterance (Deepgram speech_final text). */
  text: string;
};

export type TurnEndDecision = {
  /** true = caller has finished their turn, answer now; false = wait one more beat. */
  done: boolean;
  /** Which detector produced this decision — observability + budget-fallback attribution. */
  by: string;
  /** Present only when done=false, why we're holding. */
  reason?: "mid-thought";
};

export interface TurnEndDetector {
  readonly name: string;
  /**
   * Pure/instant for the heuristic; a network round-trip for a model-backed
   * refiner — which is exactly why any slow detector must be wrapped by
   * `withLatencyBudget` before it touches the hot path.
   */
  decide(input: TurnEndInput): Promise<TurnEndDecision>;
}
