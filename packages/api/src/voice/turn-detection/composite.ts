import type { TurnEndDetector, TurnEndInput, TurnEndDecision } from "./types";

/**
 * Compose the always-on cheap `heuristic` with an optional second detector
 * (`refiner`), so the second one is only ever consulted where it can
 * actually prevent a wrong cut-off — never on the common case. Written for a
 * model-backed refiner (see Phase V's own framing below), but the policy is
 * generic enough that D6 (phase-d-conversation.md, 2026-08-25) reuses it to
 * chain two zero-cost heuristics together too — `turn-detection/index.ts`
 * composes `HeuristicTurnDetector` (filler-word trail-off) with
 * `DictationSequenceDetector` (mid-dictation pause) exactly this way,
 * `refinerBudgetMs` moot for either since both resolve synchronously.
 *
 * Policy:
 *  - Run the heuristic first (zero I/O).
 *  - If the heuristic says NOT done (caller trailed off mid-thought), we're
 *    already holding for one more beat — a second detector can't make us
 *    hold "more", so short-circuit and skip it entirely. This is the cheap,
 *    common path.
 *  - If the heuristic says done but there's no refiner, return today's exact
 *    behavior (heuristic-only) — this is what ships by default in Phase V.
 *  - Only when the heuristic thinks the turn looks complete AND a refiner is
 *    configured do we ask it "does this actually sound finished?" — the one
 *    case where a second opinion beats the first. A model-backed refiner is
 *    expected to already be latency-budgeted (see `withLatencyBudget`); a
 *    heuristic refiner like `DictationSequenceDetector` needs no budget at
 *    all.
 */
export function createCompositeTurnDetector(
  heuristic: TurnEndDetector,
  refiner: TurnEndDetector | null,
): TurnEndDetector {
  if (!refiner) return heuristic;
  return {
    name: `composite(${heuristic.name}+${refiner.name})`,
    async decide(input: TurnEndInput): Promise<TurnEndDecision> {
      const base = await heuristic.decide(input);
      // Heuristic already wants to hold — a refiner can only agree; nothing to gain.
      if (!base.done) return base;
      // Heuristic thinks the turn is complete: this is the only place a model
      // can prevent a cut-off, so spend the (budgeted) call here.
      return refiner.decide(input);
    },
  };
}
