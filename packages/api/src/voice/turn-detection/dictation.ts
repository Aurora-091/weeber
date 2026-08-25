import type { TurnEndDetector, TurnEndInput, TurnEndDecision } from "./types";

/**
 * D6 (phase-d-conversation.md, 2026-08-25) — `endsMidThought` (heuristic.ts)
 * catches a caller trailing off on a filler word ("and...", "so...") but has
 * no idea about the different way a caller goes quiet mid-turn: pausing
 * *inside* a dictated sequence — reading a card/order number digit by
 * digit, spelling a name letter by letter, recalling a multi-part ID — none
 * of which ends on a filler word at all. External research on this named
 * failure mode (Speechmatics, Cekura) layers a lightweight semantic check on
 * top of the acoustic pause rather than a model call; this is that layer,
 * kept separate from `endsMidThought` rather than folded into it (per this
 * section's own instruction) so the two failure modes stay independently
 * testable and independently disable-able.
 *
 * Three concrete, regex-detectable signals — not a dictionary/spellcheck,
 * matching this file's own "cheap, rule-based" tradition:
 *   - a lone trailing digit, not part of a multi-digit number ("42" is
 *     whole; "four, two" spoken as "4, 2" ends on a standalone "2" once the
 *     caller pauses between digits);
 *   - a lone trailing letter (spelling something out: "j" as in "j, o, h, n");
 *   - a trailing hyphen, several STT providers' own convention (Deepgram
 *     included) for a word their model believes was cut off mid-utterance.
 *
 * Deliberately loose rather than exhaustive — a false positive here costs
 * one extra beat of the agent waiting before it answers (the existing
 * silence-timeout re-prompt is still the backstop if the caller really did
 * stop), the same tradeoff `endsMidThought` already accepts.
 */
// [.,]? tolerates a trailing period/comma the same way heuristic.ts's own
// TRAILING_FILLER_PATTERN does — a final transcript can carry punctuation
// an interim one wouldn't, and a caller mid-dictation is exactly as likely
// to have one trailing as a filler-word trail-off is.
const LONE_TRAILING_DIGIT = /\b\d[.,]?$/;
const LONE_TRAILING_LETTER = /\b[a-z][.,]?$/i;
const TRAILING_HYPHEN = /-$/;

export function endsWithIncompleteDictation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return LONE_TRAILING_DIGIT.test(trimmed) || LONE_TRAILING_LETTER.test(trimmed) || TRAILING_HYPHEN.test(trimmed);
}

export const DICTATION_DETECTOR_NAME = "dictation-sequence";

/** Same zero-I/O, synchronous-resolving shape as `HeuristicTurnDetector` —
 * see that class's doc comment for why a detector this cheap doesn't need
 * `withLatencyBudget`. */
export class DictationSequenceDetector implements TurnEndDetector {
  readonly name = DICTATION_DETECTOR_NAME;

  async decide({ text }: TurnEndInput): Promise<TurnEndDecision> {
    return endsWithIncompleteDictation(text)
      ? { done: false, by: this.name, reason: "incomplete-dictation" }
      : { done: true, by: this.name };
  }
}
