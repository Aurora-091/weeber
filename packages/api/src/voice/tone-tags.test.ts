import { describe, it, expect } from "bun:test";
import { stripToneTag, CARTESIA_EMOTION_BY_TONE, TONE_VALUES } from "./tone-tags";

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

  it("only matches at the very start — a tag-shaped string mid-sentence is left alone", () => {
    const result = stripToneTag("He said [[tone:calm]] to me once.");
    expect(result.tone).toBeNull();
    expect(result.text).toBe("He said [[tone:calm]] to me once.");
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
