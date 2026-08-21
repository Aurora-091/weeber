import { describe, it, expect } from "bun:test";
import { toSarvamLanguageCode } from "./sarvam";

/**
 * Language-code mapping for Sarvam TTS (2026-07-19,
 * docs/archive/insurance-language-variants-task.md). "hinglish" is a switchable
 * per-language variant with no dedicated Sarvam code — it must render on the
 * Hindi voice (hi-IN), which speaks the Hindi-English code-mix naturally.
 */
describe("toSarvamLanguageCode", () => {
  it("maps hinglish to the Hindi voice (hi-IN)", () => {
    expect(toSarvamLanguageCode("hinglish")).toBe("hi-IN");
  });

  it("maps hi to hi-IN", () => {
    expect(toSarvamLanguageCode("hi")).toBe("hi-IN");
  });

  it("maps en to en-IN", () => {
    expect(toSarvamLanguageCode("en")).toBe("en-IN");
  });

  it("appends -IN to other Indic codes", () => {
    expect(toSarvamLanguageCode("mr")).toBe("mr-IN");
    expect(toSarvamLanguageCode("ta")).toBe("ta-IN");
  });

  it("passes through an already BCP-47 code unchanged", () => {
    expect(toSarvamLanguageCode("bn-IN")).toBe("bn-IN");
  });

  it("falls back to the default (hi-IN) for multi / unknown / unset", () => {
    expect(toSarvamLanguageCode("multi")).toBe("hi-IN");
    expect(toSarvamLanguageCode("unknown")).toBe("hi-IN");
    expect(toSarvamLanguageCode(undefined)).toBe("hi-IN");
  });
});
