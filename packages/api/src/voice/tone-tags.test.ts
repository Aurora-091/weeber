import { describe, it, expect } from "bun:test";
import { stripToneTag, createToneTagFilter, CARTESIA_EMOTION_BY_TONE, TONE_VALUES } from "./tone-tags";

describe("stripToneTag", () => {
  it("extracts a well-formed tag and strips it from the returned text", () => {
    const result = stripToneTag("[[tone:empathetic]] I'm sorry to hear that.");
    expect(result.tone).toBe("empathetic");
    expect(result.text).toBe("I'm sorry to hear that.");
  });

  it("returns tone: null and the text unchanged when there is no tag", () => {
    const result = stripToneTag("Hi there, how can I help?");
    expect(result.tone).toBeNull();
    expect(result.text).toBe("Hi there, how can I help?");
  });

  // ADR-106 reverses this assertion. It used to read "only matches at the very
  // start — a tag-shaped string mid-sentence is left alone", on the reasoning
  // that a mid-sentence tag is never valid so leaving it alone is safe.
  // Production call 25 spoke `[[tone:upbeat]]` out loud: not valid, still
  // emitted, and the anchor's only effect was that the caller heard it. The tag
  // is a control token — never speech, in any position.
  it("strips a tag that appears mid-text, and applies its tone (ADR-106)", () => {
    const result = stripToneTag("Sending that now... [[tone:calm]] And that's everything I need.");
    expect(result.tone).toBe("calm");
    expect(result.text).toBe("Sending that now... And that's everything I need.");
  });

  it("strips every tag when the model emits more than one", () => {
    const result = stripToneTag("[[tone:calm]] One moment. [[tone:upbeat]] All set!");
    // First recognized tone wins — a turn is spoken with one voice setting.
    expect(result.tone).toBe("calm");
    expect(result.text).toBe("One moment. All set!");
  });

  it("leaves a tag-shaped string that is not a tone tag alone", () => {
    const result = stripToneTag("He said [[note:calm]] to me once.");
    expect(result.tone).toBeNull();
    expect(result.text).toBe("He said [[note:calm]] to me once.");
  });

  it("still strips a well-formed tag whose value isn't in the known vocabulary (never let it reach the caller)", () => {
    const result = stripToneTag("[[tone:euphoric]] Great news!");
    expect(result.tone).toBeNull(); // not a recognized value, so no tone is applied
    expect(result.text).toBe("Great news!"); // but the tag itself is still gone
  });

  it("is case-insensitive on the tone value", () => {
    const result = stripToneTag("[[tone:URGENT]] We need to act now.");
    expect(result.tone).toBe("urgent");
  });

  it("tolerates a leading space before the tag", () => {
    const result = stripToneTag("  [[tone:calm]] Sure, no problem.");
    expect(result.tone).toBe("calm");
    expect(result.text).toBe("Sure, no problem.");
  });

  it("handles every declared tone value round-tripping correctly", () => {
    for (const tone of TONE_VALUES) {
      const result = stripToneTag(`[[tone:${tone}]] some text`);
      expect(result.tone).toBe(tone);
      expect(result.text).toBe("some text");
    }
  });
});

describe("CARTESIA_EMOTION_BY_TONE", () => {
  it("has exactly one mapped Cartesia emotion for every declared tone value, no gaps", () => {
    for (const tone of TONE_VALUES) {
      expect(typeof CARTESIA_EMOTION_BY_TONE[tone]).toBe("string");
      expect(CARTESIA_EMOTION_BY_TONE[tone].length).toBeGreaterThan(0);
    }
  });
});

/**
 * ADR-101 — these exist because this state machine used to be a closure inside
 * stream.ts's speak(), where no test could reach it, and it was silently
 * muting short turns in production. The flush() cases below are the bug; the
 * rest pin the behaviour that was already correct so extracting it can't have
 * changed it.
 */
describe("createToneTagFilter", () => {
  function collect() {
    const text: string[] = [];
    const tones: string[] = [];
    const filter = createToneTagFilter({
      onTone: (tone) => tones.push(tone),
      onText: (t) => text.push(t),
    });
    return { filter, text, tones, spoken: () => text.join("") };
  }

  it("strips a tag split across several deltas and never speaks a partial tag", () => {
    const c = collect();
    for (const delta of ["[[to", "ne:emp", "athetic]]", " I'm sorry", " to hear that."]) {
      c.filter.push(delta);
    }
    expect(c.tones).toEqual(["empathetic"]);
    // Leading space survives because the tag closed exactly on a delta
    // boundary, so the regex's trailing `\s*` had nothing to eat and the
    // space arrived in the *next* (already-resolved) delta. Harmless — TTS
    // ignores leading whitespace — and pinned here so the behaviour is
    // recorded rather than rediscovered.
    expect(c.spoken()).toBe(" I'm sorry to hear that.");
    // Nothing forwarded before the tag closed — no chunk may contain "[[".
    expect(c.text.some((chunk) => chunk.includes("[["))).toBe(false);
  });

  it("releases at the buffer cap when the model emits no tag at all", () => {
    const c = collect();
    const long = "Thanks for confirming that, I have noted it down for the advisor.";
    for (const ch of long) c.filter.push(ch);
    expect(c.tones).toEqual([]);
    expect(c.spoken()).toBe(long);
  });

  it("forwards each delta immediately once the turn is resolved", () => {
    const c = collect();
    c.filter.push("[[tone:calm]]");
    c.filter.push("One");
    c.filter.push(" two");
    expect(c.text).toEqual(["One", " two"]);
  });

  it("strips a well-formed tag with an unknown value without reporting a tone", () => {
    const c = collect();
    c.filter.push("[[tone:euphoric]] Great news!");
    expect(c.tones).toEqual([]);
    expect(c.spoken()).toBe("Great news!");
  });

  // The bug (production call 21 turn 3, 2026-08-09): a reply short enough to
  // fit entirely inside the hold-back buffer, with no tag, satisfied none of
  // the three release conditions — so TTS was handed nothing and the caller
  // heard silence while the transcript recorded the line as spoken.
  it("flush() speaks a short untagged reply that never reached any release condition", () => {
    const c = collect();
    c.filter.push("OK.");
    expect(c.spoken()).toBe(""); // still held back, as designed — a tag might be coming
    const rescued = c.filter.flush();
    expect(rescued).toBe("OK.");
    expect(c.spoken()).toBe("OK.");
  });

  it("flush() strips a tag that arrived in the same short unflushed turn", () => {
    const c = collect();
    c.filter.push("[[tone:calm");
    const rescued = c.filter.flush();
    // Never a valid tag, so it is spoken as-is rather than silently dropped —
    // audible garbage beats dead air, and it is a model-side defect either way.
    expect(rescued).toBe("[[tone:calm");
    expect(c.spoken()).toBe("[[tone:calm");
  });

  it("flush() is a no-op on a turn that already released normally", () => {
    const c = collect();
    c.filter.push("[[tone:upbeat]] All set, thanks!");
    expect(c.filter.flush()).toBe("");
    expect(c.spoken()).toBe("All set, thanks!");
  });

  it("flush() is a no-op on a turn that produced no text at all (pure tool turn)", () => {
    const c = collect();
    expect(c.filter.flush()).toBe("");
    expect(c.text).toEqual([]);
  });

  it("flush() is idempotent", () => {
    const c = collect();
    c.filter.push("Got it.");
    expect(c.filter.flush()).toBe("Got it.");
    expect(c.filter.flush()).toBe("");
    expect(c.spoken()).toBe("Got it.");
  });

  it("keeps speaking normally after a flush (the filter stays usable)", () => {
    const c = collect();
    c.filter.push("Sure.");
    c.filter.flush();
    c.filter.push(" One moment.");
    expect(c.spoken()).toBe("Sure. One moment.");
  });
  // ADR-106 — production call 25. The model emitted a stage direction before
  // the tag, which is 23 characters and so blew TONE_TAG_MAX_BUFFER_CHARS: the
  // filter correctly concluded "no leading tag is coming", resolved, and then
  // forwarded the tag itself as speech because the resolved path was a raw
  // pass-through.
  it("strips a tag that arrives after the buffer cap already resolved the turn", () => {
    const c = collect();
    for (const delta of ["*Sending text ", "message...*", " [[tone:", "upbeat]]", " And that's everything I need."]) {
      c.filter.push(delta);
    }
    c.filter.flush();
    expect(c.spoken()).not.toContain("[[tone:");
    expect(c.spoken()).toContain("And that's everything I need.");
    expect(c.tones).toEqual(["upbeat"]);
  });

  it("strips a mid-turn tag split across deltas after a clean leading tag", () => {
    const c = collect();
    for (const delta of ["[[tone:calm]] One moment. [[to", "ne:upbeat]] All set!"]) {
      c.filter.push(delta);
    }
    c.filter.flush();
    expect(c.spoken()).not.toContain("[[");
    expect(c.spoken()).toContain("All set!");
  });

  it("releases a turn that ends on a dangling bracket instead of muting it (ADR-101's class)", () => {
    const c = collect();
    c.filter.push("Your reference is A [");
    c.filter.flush();
    expect(c.spoken()).toBe("Your reference is A [");
  });

  it("adds no delay to a turn containing no brackets at all", () => {
    const c = collect();
    c.filter.push("Thanks for confirming that, ");
    // Cap is 24 chars, so this resolved on the first delta and emitted it whole.
    expect(c.spoken()).toBe("Thanks for confirming that, ");
  });
});
