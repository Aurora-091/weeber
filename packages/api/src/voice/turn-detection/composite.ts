import type { TurnEndDetector, TurnEndInput, TurnEndDecision } from "./types";

/**
 * Compose the always-on cheap `heuristic` with an optional model-backed
 * `refiner`, so a model call is only ever spent where it can actually prevent
 * a wrong cut-off — never on the common case.
 *
 * Policy:
 *  - Run the heuristic first (zero I/O).
 *  - If the heuristic says NOT done (caller trailed off mid-thought), we're
 *    already holding for one more beat — a model can't make us hold "more",
 *    so short-circuit and skip the model call entirely. This is the cheap,
 *    common path.
 *  - If the heuristic says done but there's no refiner, return today's exact
 *    behavior (heuristic-only) — this is what ships by default in Phase V.
 *  - Only when the heuristic thinks the turn looks complete AND a refiner is
 *    configured do we ask the model "does this actually sound finished?" —
 *    the one case where semantics beat silence+regex. The refiner is expected
 *    to already be latency-budgeted (see `withLatencyBudget`).
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
