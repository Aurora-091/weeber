import { describe, expect, test } from "bun:test";
import { endsWithIncompleteDictation, DictationSequenceDetector, DICTATION_DETECTOR_NAME } from "./dictation";

/**
 * D6 (phase-d-conversation.md, 2026-08-25). Plan-specified cases first
 * (lone trailing digit/letter, mid-word via trailing hyphen, the
 * "j," pause "o-h-n at gmail dot com" synthetic scenario), then a second
 * pass of edge cases this session added on its own initiative: multi-digit/
 * multi-letter endings that must NOT be flagged (the whole point is
 * distinguishing a lone token from a complete one), punctuation tolerance,
 * case-insensitivity, and a decimal number that could plausibly confuse a
 * naive "ends in a digit" check.
 */

describe("endsWithIncompleteDictation — plan-specified cases", () => {
  test("a lone trailing digit (reading a number digit by digit, cut off mid-sequence)", () => {
    expect(endsWithIncompleteDictation("the code is 4, 2")).toBe(true);
    expect(endsWithIncompleteDictation("my card number is 4242 4242 4242 4")).toBe(true);
  });

  test("a lone trailing letter (spelling something out)", () => {
    expect(endsWithIncompleteDictation("my email is j")).toBe(true);
    expect(endsWithIncompleteDictation("that's spelled s, m, i, t")).toBe(true);
  });

  test("a trailing hyphen (STT's own cut-off-word convention)", () => {
    expect(endsWithIncompleteDictation("my name is recogn-")).toBe(true);
  });

  test("the two-fragment spelling scenario: the first half is incomplete, the second is not", () => {
    // "my email is j" [pause] "o-h-n at gmail dot com"
    expect(endsWithIncompleteDictation("my email is j")).toBe(true);
    expect(endsWithIncompleteDictation("o-h-n at gmail dot com")).toBe(false);
  });

  test("ordinary complete sentences are unaffected", () => {
    expect(endsWithIncompleteDictation("I wanted to check on my order status")).toBe(false);
    expect(endsWithIncompleteDictation("yes that's correct")).toBe(false);
    expect(endsWithIncompleteDictation("book me an appointment for tomorrow")).toBe(false);
  });
});

describe("endsWithIncompleteDictation — new edge cases (2026-08-25)", () => {
  test("a MULTI-digit number ending is NOT flagged — the whole point is distinguishing lone from whole", () => {
    expect(endsWithIncompleteDictation("my PIN is 4242")).toBe(false);
    expect(endsWithIncompleteDictation("the total comes to 42")).toBe(false);
  });

  test("ordinary multi-letter short words are NOT flagged", () => {
    for (const text of ["yes", "no", "ok", "hi", "sure", "great"]) {
      expect(endsWithIncompleteDictation(text)).toBe(false);
    }
  });

  test("a decimal number does not falsely trigger the lone-digit check", () => {
    // "4" is preceded by "1" (a word character), so there's no \b before it —
    // this must read as one contiguous number, not a lone trailing digit.
    expect(endsWithIncompleteDictation("the total is 3.14")).toBe(false);
  });

  test("trailing punctuation is tolerated, same as heuristic.ts's TRAILING_FILLER_PATTERN", () => {
    expect(endsWithIncompleteDictation("my email is j.")).toBe(true);
    expect(endsWithIncompleteDictation("the code is 4, 2,")).toBe(true);
  });

  test("case-insensitive — spelling with an uppercase letter still flags", () => {
    expect(endsWithIncompleteDictation("that's J as in John")).toBe(false); // "John" follows, not a lone trailing letter
    expect(endsWithIncompleteDictation("first letter is J")).toBe(true);
  });

  test("a hyphenated compound word ending normally is not mistaken for a cut-off", () => {
    expect(endsWithIncompleteDictation("I'm self-aware of that")).toBe(false);
    expect(endsWithIncompleteDictation("please keep it up-to-date")).toBe(false);
  });

  test("empty and whitespace-only input never flags", () => {
    expect(endsWithIncompleteDictation("")).toBe(false);
    expect(endsWithIncompleteDictation("   ")).toBe(false);
  });

  test("a single-letter or single-digit word as someone's WHOLE answer is an accepted false positive, not a crash", () => {
    // Documented tradeoff (dictation.ts's own doc comment): costs one extra
    // beat of the agent waiting, same class of imprecision endsMidThought
    // already accepts for filler words. Asserting the behavior, not
    // endorsing it as ideal, so a future change here is deliberate.
    expect(endsWithIncompleteDictation("a")).toBe(true);
    expect(endsWithIncompleteDictation("5")).toBe(true);
  });
});

describe("DictationSequenceDetector (TurnEndDetector adapter)", () => {
  test("holds with reason incomplete-dictation on a mid-sequence pause", async () => {
    const d = new DictationSequenceDetector();
    const r = await d.decide({ text: "my email is j" });
    expect(r.done).toBe(false);
    expect(r.reason).toBe("incomplete-dictation");
    expect(r.by).toBe(DICTATION_DETECTOR_NAME);
  });

  test("answers done on a complete-looking turn", async () => {
    const d = new DictationSequenceDetector();
    const r = await d.decide({ text: "I want to cancel my order" });
    expect(r.done).toBe(true);
    expect(r.by).toBe(DICTATION_DETECTOR_NAME);
  });

  test("does NOT catch a filler-word trail-off — that's endsMidThought's job, kept separate on purpose", async () => {
    const d = new DictationSequenceDetector();
    const r = await d.decide({ text: "I want to order and" });
    expect(r.done).toBe(true); // "and" is not a lone digit/letter/hyphen ending
  });
});
