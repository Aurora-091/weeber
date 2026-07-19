import { describe, it, expect } from "bun:test";
import { INSURANCE_GREETINGS, resolveLocalizedGreeting } from "./insurance-greetings";

/**
 * Config-driven per-language insurance greetings (2026-07-19,
 * docs/insurance-language-variants-task.md). The greeting is the only line
 * spoken *canned* (LLM-free), so the non-English variants must come from the
 * audited map here — never the English DB line rendered through a non-English
 * voice. A language with no audited entry must resolve to undefined so the LLM
 * greets in the configured language instead.
 */
describe("resolveLocalizedGreeting", () => {
  const englishFallback = "Hello, this is the English canned greeting.";

  it("returns the English fallback for English", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "en", englishFallback)).toBe(englishFallback);
  });

  it("returns the English fallback when no language is set", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", undefined, englishFallback)).toBe(englishFallback);
  });

  it("is case-insensitive about the language code", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "EN", englishFallback)).toBe(englishFallback);
  });

  it("returns the audited Hindi greeting for hi", () => {
    const g = resolveLocalizedGreeting("insurance-policy-renewal", "hi", englishFallback);
    expect(g).toBe(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi!);
    expect(g).not.toBe(englishFallback);
  });

  it("returns the audited Hinglish greeting for hinglish", () => {
    const g = resolveLocalizedGreeting("insurance-post-sale-welcome", "hinglish", englishFallback);
    expect(g).toBe(INSURANCE_GREETINGS["insurance-post-sale-welcome"]!.hinglish!);
    expect(g).not.toBe(englishFallback);
  });

  it("returns undefined for a language with no audited translation (e.g. Marathi) — LLM greets instead", () => {
    expect(resolveLocalizedGreeting("insurance-policy-renewal", "mr", englishFallback)).toBeUndefined();
  });

  it("returns undefined when the template key is unknown / not an insurance template", () => {
    expect(resolveLocalizedGreeting("shopify-cart-recovery", "hi", englishFallback)).toBeUndefined();
  });

  it("returns undefined when there is no template key", () => {
    expect(resolveLocalizedGreeting(undefined, "hi", englishFallback)).toBeUndefined();
  });

  it("covers all five India insurance templates (04–08) with both hi and hinglish", () => {
    const keys = [
      "insurance-policy-renewal",
      "insurance-lead-followup",
      "insurance-appointment-setter",
      "insurance-post-sale-welcome",
      "insurance-feedback-nps",
    ];
    for (const key of keys) {
      expect(INSURANCE_GREETINGS[key]?.hi).toBeString();
      expect(INSURANCE_GREETINGS[key]?.hinglish).toBeString();
    }
  });

  it("keeps merge tags intact in the localized greetings (so renderTemplate + the unresolved-tag guard still work)", () => {
    expect(INSURANCE_GREETINGS["insurance-policy-renewal"]!.hi).toContain("{{company_name}}");
    expect(INSURANCE_GREETINGS["insurance-post-sale-welcome"]!.hinglish).toContain("{{policyholder_name}}");
  });
});
