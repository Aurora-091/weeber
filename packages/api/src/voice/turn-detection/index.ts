import type { TurnEndDetector } from "./types";
import { HeuristicTurnDetector } from "./heuristic";
import { withLatencyBudget } from "./budgeted";
import { createCompositeTurnDetector } from "./composite";

export type { TurnEndDetector } from "./types";

/**
 * Org feature flag (same pattern as EXPRESSIVE_DELIVERY_FLAG / backchannels):
 * a co-located constant resolved once per call from effectiveFlagsResult, NOT
 * a DB column — so shipping the seam needs no migration. Default OFF: with no
 * refiner wired, the factory returns the plain heuristic and behavior is
 * byte-identical to today.
 */
export const SEMANTIC_TURN_DETECTION_FLAG = "semantic-turn-detection";

/**
 * Latency budget for a model-backed refiner before it degrades to the
 * heuristic. 300ms keeps worst-case added end-of-turn latency bounded well
 * under a human's turn-taking gap; a model that can't answer in time simply
 * isn't allowed to slow the hot path.
 */
export const DEFAULT_REFINER_BUDGET_MS = 300;

export type TurnDetectorConfig = {
  /** Resolved value of SEMANTIC_TURN_DETECTION_FLAG for this org/call. */
  semanticEnabled: boolean;
  /**
   * The model-backed detector, if one is wired. Phase V ships with this
   * always null (no vendor) — the seam is here, the model is deferred per the
   * build-plan gate (needs Phase II production data + staging isolation).
   */
  refiner?: TurnEndDetector | null;
  /** Override the refiner latency budget; defaults to DEFAULT_REFINER_BUDGET_MS. */
  refinerBudgetMs?: number;
};

/**
 * The single entry point stream.ts uses to build a per-call detector. When
 * the flag is off OR no refiner is configured (the Phase V default) it returns
 * a bare `HeuristicTurnDetector` — same object, same behavior as calling
 * `endsMidThought` inline. Only when a refiner is present AND the flag is on
 * does it build the budgeted composite. Wiring a real model later is exactly
 * this: pass a `refiner`, flip the flag.
 */
export function createTurnDetector(config: TurnDetectorConfig): TurnEndDetector {
  const heuristic = new HeuristicTurnDetector();
  const refiner = config.refiner ?? null;
  if (!config.semanticEnabled || !refiner) return heuristic;
  const budgeted = withLatencyBudget(
    refiner,
    heuristic,
    config.refinerBudgetMs ?? DEFAULT_REFINER_BUDGET_MS,
  );
  return createCompositeTurnDetector(heuristic, budgeted);
}
