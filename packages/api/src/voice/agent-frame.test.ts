import { describe, it, expect } from "bun:test";
import { RECOMMENDED_LANGUAGES, SARVAM_PREFERRED_LANGUAGES, prefersSarvam } from "./agent-frame";

/**
 * Hinglish as a first-class switchable language variant (2026-07-19,
 * docs/archive/insurance-language-variants-task.md). It must be offerable in the UI
 * (RECOMMENDED_LANGUAGES → datalist) and route to Sarvam when no provider is
 * explicitly set (its Hindi voice renders the code-mix best).
 */
describe("agent-frame language config — hinglish", () => {
  it("offers hinglish as a recommended language", () => {
    expect(RECOMMENDED_LANGUAGES.some((l) => l.code === "hinglish")).toBe(true);
  });

  it("lists hinglish among the Sarvam-preferred languages", () => {
    expect((SARVAM_PREFERRED_LANGUAGES as readonly string[]).includes("hinglish")).toBe(true);
  });

  it("prefersSarvam is true for hinglish (case-insensitive)", () => {
    expect(prefersSarvam("hinglish")).toBe(true);
    expect(prefersSarvam("Hinglish")).toBe(true);
  });

  it("prefersSarvam stays true for hi and false for en / empty", () => {
    expect(prefersSarvam("hi")).toBe(true);
    expect(prefersSarvam("en")).toBe(false);
    expect(prefersSarvam(null)).toBe(false);
    expect(prefersSarvam(undefined)).toBe(false);
  });
});
