import type { TurnEndDetector, TurnEndInput, TurnEndDecision } from "./types";

/**
 * A1b (VAD/endpointing audit, 2026-07-14): Deepgram's `endpointing`/
 * `speech_final` is a single fixed-silence-timeout signal — it has no idea
 * whether the caller's sentence is actually grammatically complete. A
 * caller who pauses mid-thought right after a conjunction/filler ("and...",
 * "so...", "um...") can get cut off and answered on a fragment. This is a
 * cheap, rule-based regex-context check (not a model call) layered on top
 * of the vendor signal, matching the report's "endpointing as rule-based +
 * regex-context, not vendor-signal-alone" recommendation — the caller
 * simply gets treated as still-mid-turn for one more beat; the existing
 * silence-timeout re-prompt is still the backstop if they really did stop.
 *
 * Phase V (2026-07-31): moved here from stream.ts unchanged, so it can be the
 * default `TurnEndDetector` (and the budget fallback for any future model)
 * without a circular import. stream.ts re-exports it for back-compat.
 */
const TRAILING_FILLER_PATTERN = /\b(and|so|but|or|because|um+|uh+|like|well|then)[.,]?$/i;

export function endsMidThought(text: string): boolean {
  return TRAILING_FILLER_PATTERN.test(text.trim());
}

export const HEURISTIC_DETECTOR_NAME = "heuristic";

/**
 * The default detector and the always-available fallback: wraps the pure
 * `endsMidThought` regex in the `TurnEndDetector` interface. Zero I/O, so its
 * `decide` resolves synchronously — using it inline adds no real latency over
 * calling `endsMidThought` directly.
 */
export class HeuristicTurnDetector implements TurnEndDetector {
  readonly name = HEURISTIC_DETECTOR_NAME;

  async decide({ text }: TurnEndInput): Promise<TurnEndDecision> {
    return endsMidThought(text)
      ? { done: false, by: this.name, reason: "mid-thought" }
      : { done: true, by: this.name };
  }
}
